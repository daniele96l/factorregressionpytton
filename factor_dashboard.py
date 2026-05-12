"""
Run:
  pip install -r requirements.txt
  python factor_dashboard.py
"""

import base64
import io
from pathlib import Path

import dash
from dash import Dash, Input, Output, State, dcc, html, dash_table
import numpy as np
import pandas as pd
import plotly.express as px
import plotly.graph_objects as go
import statsmodels.api as sm


FACTOR_FILE = Path(__file__).resolve().parent / "3factormodelusa.csv"
DEFAULT_PORTFOLIO_FILE = Path(__file__).resolve().parent / "smallcapvalueusa.csv"
DEFAULT_PORTFOLIO_COLUMN = "MSCI USA Small Cap Value Weighted"
FX_FILE = Path(__file__).resolve().parent / "usd_eur_rate_rows.csv"


def parse_ff3_factors(raw: pd.DataFrame, daily: bool = False) -> pd.DataFrame:
    raw = raw.rename(columns={raw.columns[0]: "Date"})
    raw["Date"] = raw["Date"].astype(str).str.strip()
    monthly_rows = raw[raw["Date"].str.fullmatch(r"\d{6}", na=False)].copy()
    daily_rows = raw[raw["Date"].str.fullmatch(r"\d{8}", na=False)].copy()

    base_cols = ["Mkt-RF", "SMB", "HML", "RF"]
    optional_cols = [c for c in ["RMW", "CMA"] if c in raw.columns]
    cols = [*base_cols[:-1], *optional_cols, "RF"]

    if daily:
        if daily_rows.empty:
            raise ValueError("Daily mode needs a daily Fama-French file (YYYYMMDD dates).")
        daily_rows["Date"] = pd.to_datetime(daily_rows["Date"], format="%Y%m%d", errors="coerce")
        for col in cols:
            daily_rows[col] = pd.to_numeric(daily_rows[col], errors="coerce") / 100.0
        daily_rows = daily_rows.dropna(subset=["Date", *cols]).sort_values("Date")
        return daily_rows[["Date", *cols]]

    if not monthly_rows.empty:
        monthly_rows["Date"] = pd.to_datetime(monthly_rows["Date"], format="%Y%m") + pd.offsets.MonthEnd(0)
        for col in cols:
            monthly_rows[col] = pd.to_numeric(monthly_rows[col], errors="coerce") / 100.0
        monthly_rows = monthly_rows.dropna(subset=cols).sort_values("Date")
        return monthly_rows[["Date", *cols]]

    if not daily_rows.empty:
        daily_rows["Date"] = pd.to_datetime(daily_rows["Date"], format="%Y%m%d", errors="coerce")
        for col in cols:
            daily_rows[col] = pd.to_numeric(daily_rows[col], errors="coerce") / 100.0
        daily_rows = daily_rows.dropna(subset=["Date", *cols]).sort_values("Date")
        daily_rows["MonthEnd"] = daily_rows["Date"] + pd.offsets.MonthEnd(0)

        # Convert daily factors to monthly by compounding within each month.
        monthly_from_daily = (
            daily_rows.groupby("MonthEnd", as_index=False)[cols]
            .apply(lambda g: pd.Series({c: (1.0 + g[c]).prod() - 1.0 for c in cols}))
            .reset_index(drop=True)
        )
        monthly_from_daily = monthly_from_daily.rename(columns={"MonthEnd": "Date"})
        return monthly_from_daily[["Date", *cols]].sort_values("Date")

    raise ValueError("Factor file format not recognized: expected YYYYMM or YYYYMMDD dates.")


def load_ff3_factors(path: Path, daily: bool = False) -> pd.DataFrame:
    raw = pd.read_csv(path, skiprows=4)
    return parse_ff3_factors(raw, daily=daily)


def load_ff3_factors_from_content(contents: str, fallback_path: Path, daily: bool = False) -> tuple[pd.DataFrame, str]:
    if contents:
        _, content_string = contents.split(",", 1)
        decoded = base64.b64decode(content_string)
        raw = pd.read_csv(io.StringIO(decoded.decode("utf-8")), skiprows=4)
        return parse_ff3_factors(raw, daily=daily), "Uploaded factor file"
    return load_ff3_factors(fallback_path, daily=daily), fallback_path.name


def load_portfolio_prices_from_content(contents: str, fallback_path: Path) -> pd.DataFrame:
    if contents:
        _, content_string = contents.split(",", 1)
        decoded = base64.b64decode(content_string)
        try:
            df = pd.read_csv(io.StringIO(decoded.decode("utf-8")))
        except UnicodeDecodeError:
            df = pd.read_csv(io.StringIO(decoded.decode("latin-1")))
    else:
        df = pd.read_csv(fallback_path)

    if "Date" not in df.columns:
        raise ValueError("Portfolio CSV must contain a 'Date' column.")

    numeric_cols = [c for c in df.columns if c != "Date" and pd.api.types.is_numeric_dtype(df[c])]
    if DEFAULT_PORTFOLIO_COLUMN in df.columns:
        portfolio_col = DEFAULT_PORTFOLIO_COLUMN
    elif numeric_cols:
        portfolio_col = numeric_cols[0]
    else:
        raise ValueError("No numeric portfolio index column found in uploaded CSV.")

    out = df[["Date", portfolio_col]].copy()
    out = out.rename(columns={portfolio_col: "IndexLevel"})
    date_raw = out["Date"].astype(str).str.strip()
    parsed_date = (
        pd.to_datetime(date_raw, format="%m/%Y", errors="coerce")
        .fillna(pd.to_datetime(date_raw, format="%Y-%m-%d", errors="coerce"))
        .fillna(pd.to_datetime(date_raw, format="%Y%m", errors="coerce"))
        .fillna(pd.to_datetime(date_raw, format="%d/%m/%Y", errors="coerce"))
    )
    out["Date"] = parsed_date + pd.offsets.MonthEnd(0)
    out["IndexLevel"] = pd.to_numeric(out["IndexLevel"].astype(str).str.replace(",", "", regex=False), errors="coerce")
    out = out.dropna(subset=["Date", "IndexLevel"]).sort_values("Date")
    if out.empty:
        raise ValueError("Portfolio CSV parsed but no valid date/value rows were found.")
    return out


def load_usd_eur_rates(path: Path, daily: bool = False) -> pd.DataFrame:
    fx = pd.read_csv(path, usecols=["date", "rate"])
    fx["Date"] = pd.to_datetime(fx["date"], errors="coerce")
    if not daily:
        fx["Date"] = fx["Date"] + pd.offsets.MonthEnd(0)
    fx["USDEUR"] = pd.to_numeric(fx["rate"], errors="coerce")
    fx = fx.dropna(subset=["Date", "USDEUR"]).sort_values("Date")
    if not daily:
        fx = fx.groupby("Date", as_index=False)["USDEUR"].last()
    return fx[["Date", "USDEUR"]]


def load_usd_eur_rates_from_content(contents: str, fallback_path: Path, daily: bool = False) -> tuple[pd.DataFrame, str]:
    if contents:
        _, content_string = contents.split(",", 1)
        decoded = base64.b64decode(content_string)
        fx = pd.read_csv(io.StringIO(decoded.decode("utf-8")), usecols=["date", "rate"])
        fx["Date"] = pd.to_datetime(fx["date"], errors="coerce")
        if not daily:
            fx["Date"] = fx["Date"] + pd.offsets.MonthEnd(0)
        fx["USDEUR"] = pd.to_numeric(fx["rate"], errors="coerce")
        fx = fx.dropna(subset=["Date", "USDEUR"]).sort_values("Date")
        if not daily:
            fx = fx.groupby("Date", as_index=False)["USDEUR"].last()
        return fx[["Date", "USDEUR"]], "Uploaded FX file"
    return load_usd_eur_rates(fallback_path, daily=daily), fallback_path.name


def build_regression_dataset(
    contents: str, factor_contents: str, factor_choice: str, daily: bool = False
) -> tuple[pd.DataFrame, str, list[str]]:
    if factor_choice == "uploaded":
        factors, factor_label = load_ff3_factors_from_content(factor_contents, FACTOR_FILE, daily=daily)
    else:
        factors, factor_label = load_ff3_factors(FACTOR_FILE, daily=daily), FACTOR_FILE.name
    portfolio = load_portfolio_prices_from_content(contents, DEFAULT_PORTFOLIO_FILE)

    if not daily:
        portfolio = portfolio.copy()
        portfolio["PortfolioReturn"] = portfolio["IndexLevel"].pct_change()
        portfolio = portfolio.dropna(subset=["PortfolioReturn"])
        merged = portfolio.merge(factors, on="Date", how="inner")
    else:
        merged = pd.merge_asof(
            factors.sort_values("Date"),
            portfolio.sort_values("Date")[["Date", "IndexLevel"]],
            on="Date",
            direction="backward",
        )
        merged["PortfolioReturn"] = merged["IndexLevel"].pct_change()
        merged = merged.dropna(subset=["IndexLevel"])

    if merged.empty:
        raise ValueError("No overlapping dates between portfolio and factor data.")

    factor_cols = [c for c in ["Mkt-RF", "SMB", "HML", "RMW", "CMA"] if c in merged.columns]
    merged["ExcessReturn"] = merged["PortfolioReturn"] - merged["RF"]
    merged = merged.dropna(subset=["ExcessReturn", *factor_cols]).sort_values("Date")
    return merged, factor_label, factor_cols


def run_factor_regression(
    dataset: pd.DataFrame,
    factor_cols: list[str],
    algo: str,
    ridge_alpha: float,
    daily: bool = False,
) -> tuple[pd.DataFrame, dict, np.ndarray, pd.Series]:
    x = dataset[factor_cols]
    y = dataset["ExcessReturn"]

    min_obs = 252 if daily else 24
    if len(dataset) < min_obs:
        unit = "daily" if daily else "monthly"
        raise ValueError(f"Not enough observations. Need at least {min_obs} {unit} points.")

    x_const = sm.add_constant(x, has_constant="add")
    n_obs = len(y)
    k = len(factor_cols)

    if algo == "ridge":
        x_mat = x_const.to_numpy()
        y_mat = y.to_numpy()
        i = np.eye(x_mat.shape[1])
        i[0, 0] = 0.0  # do not penalize intercept
        beta = np.linalg.solve(x_mat.T @ x_mat + float(ridge_alpha) * i, x_mat.T @ y_mat)
        params = pd.Series(beta, index=x_const.columns)
        fitted = x_mat @ beta
        residuals = y_mat - fitted
        sse = float(np.sum(residuals**2))
        sst = float(np.sum((y_mat - np.mean(y_mat)) ** 2))
        r2 = 1.0 - (sse / sst) if sst > 0 else np.nan
        adj_r2 = 1.0 - (1.0 - r2) * (n_obs - 1) / (n_obs - k - 1) if n_obs > (k + 1) else np.nan
        coeff_table = pd.DataFrame(
            {"Term": params.index, "Coefficient": params.values, "t-Stat": np.nan, "p-Value": np.nan}
        )
        metrics = {
            "Observations": int(n_obs),
            "R-squared": float(r2) if pd.notna(r2) else np.nan,
            "Adj R-squared": float(adj_r2) if pd.notna(adj_r2) else np.nan,
            "RMSE": float(np.sqrt(np.mean(residuals**2))),
            "Alpha (const)": float(params["const"]),
        }
        return coeff_table, metrics, fitted, params

    model = sm.OLS(y, x_const)
    results = model.fit()
    fitted = results.predict(x_const)
    params = results.params
    coeff_table = pd.DataFrame(
        {
            "Term": params.index,
            "Coefficient": params.values,
            "t-Stat": results.tvalues.values,
            "p-Value": results.pvalues.values,
        }
    )
    rmse = float(np.sqrt(np.mean((y - fitted) ** 2)))
    metrics = {
        "Observations": int(results.nobs),
        "R-squared": float(results.rsquared),
        "Adj R-squared": float(results.rsquared_adj),
        "RMSE": rmse,
        "Alpha (const)": float(params["const"]),
    }
    return coeff_table, metrics, fitted, params


def build_reconstructed_history(
    params: pd.Series, portfolio_prices: pd.DataFrame, factors: pd.DataFrame, factor_cols: list[str]
) -> pd.DataFrame:
    factors = factors.copy()
    x_full = sm.add_constant(factors[factor_cols], has_constant="add")
    ordered_params = params.reindex(x_full.columns).fillna(0.0).to_numpy()
    factors["PredExcess"] = x_full.to_numpy() @ ordered_params
    factors["PredReturn"] = factors["PredExcess"] + factors["RF"]

    factor_dates = set(factors["Date"].tolist())
    overlapping_portfolio = portfolio_prices[portfolio_prices["Date"].isin(factor_dates)].dropna(subset=["Date", "IndexLevel"]).sort_values("Date")
    if overlapping_portfolio.empty:
        raise ValueError("No overlapping portfolio date found in factor timeline for reconstruction anchor.")
    anchor_row = overlapping_portfolio.iloc[0]
    anchor_date = anchor_row["Date"]
    anchor_level = float(anchor_row["IndexLevel"])

    factors = factors.sort_values("Date").copy()
    factors["ReconstructedLevel"] = np.nan
    anchor_idx = factors.index[factors["Date"] == anchor_date]
    if len(anchor_idx) == 0:
        raise ValueError("Anchor date not found in factor timeline.")
    anchor_idx = anchor_idx[0]
    factors.loc[anchor_idx, "ReconstructedLevel"] = anchor_level

    idx_positions = list(factors.index)
    anchor_pos = idx_positions.index(anchor_idx)

    for i in range(anchor_pos + 1, len(idx_positions)):
        prev_idx = idx_positions[i - 1]
        curr_idx = idx_positions[i]
        factors.loc[curr_idx, "ReconstructedLevel"] = factors.loc[prev_idx, "ReconstructedLevel"] * (
            1 + factors.loc[curr_idx, "PredReturn"]
        )

    for i in range(anchor_pos - 1, -1, -1):
        curr_idx = idx_positions[i]
        next_idx = idx_positions[i + 1]
        factors.loc[curr_idx, "ReconstructedLevel"] = factors.loc[next_idx, "ReconstructedLevel"] / (
            1 + factors.loc[next_idx, "PredReturn"]
        )

    return factors[["Date", "ReconstructedLevel"]]


def make_empty_figure(message: str) -> go.Figure:
    fig = go.Figure()
    fig.add_annotation(text=message, x=0.5, y=0.5, showarrow=False, xref="paper", yref="paper")
    fig.update_xaxes(visible=False)
    fig.update_yaxes(visible=False)
    fig.update_layout(template="plotly_white", height=360)
    return fig


app: Dash = dash.Dash(__name__)
app.title = "Factor Regression Dashboard"

app.layout = html.Div(
    style={"maxWidth": "1200px", "margin": "0 auto", "padding": "18px"},
    children=[
        html.H2("Fama-French 3-Factor Regression"),
        dcc.Upload(
            id="portfolio-upload",
            children=html.Div(["Drag and drop or ", html.A("select a portfolio CSV")]),
            style={
                "width": "100%",
                "height": "62px",
                "lineHeight": "62px",
                "borderWidth": "1px",
                "borderStyle": "dashed",
                "borderRadius": "8px",
                "textAlign": "center",
                "marginBottom": "10px",
            },
            multiple=False,
        ),
        html.Div(id="portfolio-file-feedback", style={"marginBottom": "8px", "color": "#555"}),
        dcc.Upload(
            id="factor-upload",
            children=html.Div(["Optional: upload a factor CSV (same FF3 format)"]),
            style={
                "width": "100%",
                "height": "48px",
                "lineHeight": "48px",
                "borderWidth": "1px",
                "borderStyle": "dashed",
                "borderRadius": "8px",
                "textAlign": "center",
                "marginBottom": "10px",
            },
            multiple=False,
        ),
        html.Div(id="factor-file-feedback", style={"marginBottom": "10px", "color": "#555"}),
        dcc.Upload(
            id="fx-upload",
            children=html.Div(["Optional: upload USD/EUR CSV (date, rate)"]),
            style={
                "width": "100%",
                "height": "48px",
                "lineHeight": "48px",
                "borderWidth": "1px",
                "borderStyle": "dashed",
                "borderRadius": "8px",
                "textAlign": "center",
                "marginBottom": "10px",
            },
            multiple=False,
        ),
        html.Div(id="fx-file-feedback", style={"marginBottom": "10px", "color": "#555"}),
        html.Div(
            style={"width": "100%", "marginBottom": "10px", "boxSizing": "border-box"},
            children=[
                html.Div(
                    style={
                        "display": "grid",
                        "gridTemplateColumns": "repeat(auto-fit, minmax(min(100%, 220px), 1fr))",
                        "gap": "10px",
                        "marginBottom": "10px",
                    },
                    children=[
                        dcc.Dropdown(
                            id="factor-choice",
                            options=[
                                {"label": f"Default: {FACTOR_FILE.name}", "value": "default"},
                                {"label": "Use uploaded factor file", "value": "uploaded"},
                            ],
                            value="default",
                            clearable=False,
                            style={"width": "100%"},
                        ),
                        dcc.Dropdown(
                            id="fx-choice",
                            options=[
                                {"label": f"FX default: {FX_FILE.name}", "value": "default"},
                                {"label": "Use uploaded FX file", "value": "uploaded"},
                            ],
                            value="default",
                            clearable=False,
                            style={"width": "100%"},
                        ),
                        html.Div(
                            style={"display": "flex", "flexWrap": "wrap", "gap": "10px", "alignItems": "center"},
                            children=[
                                dcc.Dropdown(
                                    id="regression-algo",
                                    options=[
                                        {"label": "OLS", "value": "ols"},
                                        {"label": "Ridge (L2)", "value": "ridge"},
                                    ],
                                    value="ols",
                                    clearable=False,
                                    style={"minWidth": "110px", "flex": "1 1 110px"},
                                ),
                                dcc.Input(
                                    id="ridge-alpha",
                                    type="number",
                                    value=1.0,
                                    min=0.0,
                                    step=0.1,
                                    debounce=True,
                                    placeholder="Ridge alpha",
                                    style={"width": "120px", "flex": "0 0 auto"},
                                ),
                            ],
                        ),
                    ],
                ),
                html.Div(
                    style={
                        "display": "flex",
                        "flexWrap": "wrap",
                        "gap": "12px",
                        "alignItems": "center",
                        "width": "100%",
                    },
                    children=[
                        html.Div(
                            style={"flex": "1 1 280px", "minWidth": "min(100%, 240px)", "maxWidth": "100%"},
                            children=[
                                dcc.DatePickerRange(
                                    id="date-range",
                                    display_format="YYYY-MM-DD",
                                    style={"width": "100%"},
                                ),
                            ],
                        ),
                        html.Div(
                            style={
                                "display": "flex",
                                "flexWrap": "wrap",
                                "gap": "10px",
                                "alignItems": "center",
                                "flex": "1 1 auto",
                            },
                            children=[
                                dcc.RadioItems(
                                    id="frequency-mode",
                                    options=[
                                        {"label": " Monthly ", "value": "monthly"},
                                        {"label": " Daily ", "value": "daily"},
                                    ],
                                    value="monthly",
                                    inline=True,
                                    style={"whiteSpace": "nowrap"},
                                ),
                                html.Button("Run Regression", id="run-btn", n_clicks=0),
                                html.Button("Download Results CSV", id="download-btn", n_clicks=0),
                            ],
                        ),
                    ],
                ),
            ],
        ),
        dcc.Download(id="download-results"),
        dcc.Store(id="result-store"),
        html.Div(id="status-msg", style={"marginBottom": "12px", "color": "#444"}),
        html.Div(id="metrics-cards", style={"display": "flex", "gap": "10px", "flexWrap": "wrap"}),
        html.H4("Regression Coefficients"),
        dash_table.DataTable(
            id="coef-table",
            columns=[
                {"name": "Term", "id": "Term"},
                {"name": "Coefficient", "id": "Coefficient"},
                {"name": "t-Stat", "id": "t-Stat"},
                {"name": "p-Value", "id": "p-Value"},
            ],
            data=[],
            style_table={"overflowX": "auto"},
            style_cell={"textAlign": "left", "padding": "6px"},
        ),
        dcc.Graph(id="exposure-bar"),
        dcc.Graph(id="actual-vs-fitted"),
        dcc.Graph(id="residuals-time"),
        dcc.Graph(id="cum-returns"),
        dcc.Graph(id="reconstructed-history"),
        dcc.Graph(id="reconstructed-history-fx"),
    ],
)


@app.callback(
    Output("date-range", "min_date_allowed"),
    Output("date-range", "max_date_allowed"),
    Output("date-range", "start_date"),
    Output("date-range", "end_date"),
    Input("portfolio-upload", "contents"),
    Input("factor-upload", "contents"),
    Input("factor-choice", "value"),
    Input("frequency-mode", "value"),
)
def refresh_date_bounds(contents, factor_contents, factor_choice, frequency_mode):
    try:
        daily = frequency_mode == "daily"
        ds, _, _ = build_regression_dataset(contents, factor_contents, factor_choice, daily=daily)
        min_date = ds["Date"].min().date()
        max_date = ds["Date"].max().date()
        return min_date, max_date, min_date, max_date
    except Exception:
        return None, None, None, None


@app.callback(
    Output("portfolio-file-feedback", "children"),
    Output("factor-file-feedback", "children"),
    Output("fx-file-feedback", "children"),
    Input("portfolio-upload", "filename"),
    Input("factor-upload", "filename"),
    Input("factor-choice", "value"),
    Input("fx-upload", "filename"),
    Input("fx-choice", "value"),
)
def show_selected_files(portfolio_filename, factor_filename, factor_choice, fx_filename, fx_choice):
    portfolio_text = f"Selected portfolio file: {portfolio_filename}" if portfolio_filename else (
        f"Selected portfolio file: {DEFAULT_PORTFOLIO_FILE.name} (default)"
    )
    if factor_choice == "uploaded":
        factor_text = f"Selected factor file: {factor_filename} (active)" if factor_filename else "Selected factor file: none"
    else:
        if factor_filename:
            factor_text = f"Selected factor file: {FACTOR_FILE.name} (default active). Uploaded detected: {factor_filename}"
        else:
            factor_text = f"Selected factor file: {FACTOR_FILE.name} (default active)"
    if fx_choice == "uploaded":
        fx_text = f"Selected FX file: {fx_filename} (active)" if fx_filename else "Selected FX file: none"
    else:
        if fx_filename:
            fx_text = f"Selected FX file: {FX_FILE.name} (default active). Uploaded detected: {fx_filename}"
        else:
            fx_text = f"Selected FX file: {FX_FILE.name} (default active)"
    return portfolio_text, factor_text, fx_text


@app.callback(
    Output("factor-choice", "value"),
    Input("factor-upload", "filename"),
    State("factor-choice", "value"),
    prevent_initial_call=True,
)
def auto_activate_uploaded_factor(factor_filename, current_choice):
    if factor_filename:
        return "uploaded"
    return current_choice


@app.callback(
    Output("fx-choice", "value"),
    Input("fx-upload", "filename"),
    State("fx-choice", "value"),
    prevent_initial_call=True,
)
def auto_activate_uploaded_fx(fx_filename, current_choice):
    if fx_filename:
        return "uploaded"
    return current_choice


@app.callback(
    Output("factor-choice", "options"),
    Input("factor-upload", "filename"),
)
def update_factor_dropdown_options(factor_filename):
    uploaded_label = f"Use uploaded: {factor_filename}" if factor_filename else "Use uploaded factor file"
    return [
        {"label": f"Default: {FACTOR_FILE.name}", "value": "default"},
        {"label": uploaded_label, "value": "uploaded"},
    ]


@app.callback(
    Output("fx-choice", "options"),
    Input("fx-upload", "filename"),
)
def update_fx_dropdown_options(fx_filename):
    uploaded_label = f"Use uploaded FX: {fx_filename}" if fx_filename else "Use uploaded FX file"
    return [
        {"label": f"FX default: {FX_FILE.name}", "value": "default"},
        {"label": uploaded_label, "value": "uploaded"},
    ]


@app.callback(
    Output("status-msg", "children"),
    Output("metrics-cards", "children"),
    Output("coef-table", "data"),
    Output("exposure-bar", "figure"),
    Output("actual-vs-fitted", "figure"),
    Output("residuals-time", "figure"),
    Output("cum-returns", "figure"),
    Output("reconstructed-history", "figure"),
    Output("reconstructed-history-fx", "figure"),
    Output("result-store", "data"),
    Input("run-btn", "n_clicks"),
    State("portfolio-upload", "contents"),
    State("factor-upload", "contents"),
    State("factor-choice", "value"),
    State("fx-upload", "contents"),
    State("fx-choice", "value"),
    State("regression-algo", "value"),
    State("ridge-alpha", "value"),
    State("date-range", "start_date"),
    State("date-range", "end_date"),
    State("frequency-mode", "value"),
    prevent_initial_call=True,
)
def run_analysis(
    _,
    contents,
    factor_contents,
    factor_choice,
    fx_contents,
    fx_choice,
    regression_algo,
    ridge_alpha,
    start_date,
    end_date,
    frequency_mode,
):
    try:
        daily = frequency_mode == "daily"
        portfolio_prices = load_portfolio_prices_from_content(contents, DEFAULT_PORTFOLIO_FILE)
        ds, factor_label, factor_cols = build_regression_dataset(
            contents, factor_contents, factor_choice, daily=daily
        )
        factors = (
            load_ff3_factors_from_content(factor_contents, FACTOR_FILE, daily=daily)[0]
            if factor_choice == "uploaded"
            else load_ff3_factors(FACTOR_FILE, daily=daily)
        )
        fx_rates, fx_label = (
            load_usd_eur_rates_from_content(fx_contents, FX_FILE, daily=daily)
            if fx_choice == "uploaded"
            else (load_usd_eur_rates(FX_FILE, daily=daily), FX_FILE.name)
        )
        if start_date and end_date:
            start = pd.to_datetime(start_date)
            end = pd.to_datetime(end_date)
            ds = ds[(ds["Date"] >= start) & (ds["Date"] <= end)].copy()

        coeff_table, metrics, fitted, params = run_factor_regression(
            ds,
            factor_cols,
            regression_algo or "ols",
            ridge_alpha if ridge_alpha is not None else 1.0,
            daily=daily,
        )
        ds["FittedExcess"] = fitted
        ds["Residual"] = ds["ExcessReturn"] - ds["FittedExcess"]
        ds["CumActualExcess"] = (1 + ds["ExcessReturn"]).cumprod() - 1
        ds["CumFittedExcess"] = (1 + ds["FittedExcess"]).cumprod() - 1

        cards = [
            html.Div(
                [
                    html.Div(k, style={"fontSize": "12px", "color": "#666"}),
                    html.Div(f"{v:.4f}" if isinstance(v, float) else str(v), style={"fontSize": "18px"}),
                ],
                style={"border": "1px solid #ddd", "borderRadius": "6px", "padding": "10px", "minWidth": "150px"},
            )
            for k, v in metrics.items()
        ]

        coef_out = coeff_table.copy()
        for col in ["Coefficient", "t-Stat", "p-Value"]:
            coef_out[col] = coef_out[col].map(lambda x: f"{x:.6f}")

        exposure_df = coeff_table[coeff_table["Term"].isin(factor_cols)]
        exposure_fig = px.bar(exposure_df, x="Term", y="Coefficient", title="Factor Exposures (Betas)")
        exposure_fig.update_layout(template="plotly_white", height=360)

        scatter_fig = px.scatter(
            ds, x="FittedExcess", y="ExcessReturn", title="Actual vs Fitted Excess Return", trendline="ols"
        )
        scatter_fig.update_layout(template="plotly_white", height=360)

        residual_fig = px.line(ds, x="Date", y="Residual", title="Residuals Over Time")
        residual_fig.add_hline(y=0, line_dash="dash")
        residual_fig.update_layout(template="plotly_white", height=360)

        cum_fig = go.Figure()
        cum_fig.add_trace(go.Scatter(x=ds["Date"], y=ds["CumActualExcess"], mode="lines", name="Actual Excess"))
        cum_fig.add_trace(go.Scatter(x=ds["Date"], y=ds["CumFittedExcess"], mode="lines", name="Fitted Excess"))
        cum_fig.update_layout(title="Cumulative Excess Return: Actual vs Fitted", template="plotly_white", height=360)

        reconstructed = build_reconstructed_history(params, portfolio_prices, factors, factor_cols)
        actual_series = portfolio_prices[["Date", "IndexLevel"]].sort_values("Date")

        reconstructed = reconstructed.merge(fx_rates, on="Date", how="left")
        actual_series = actual_series.merge(fx_rates, on="Date", how="left")
        reconstructed["USDEUR"] = reconstructed["USDEUR"].ffill().bfill()
        actual_series["USDEUR"] = actual_series["USDEUR"].ffill().bfill()
        if reconstructed["USDEUR"].isna().any() or actual_series["USDEUR"].isna().any():
            raise ValueError("Missing USD/EUR rates for one or more dates.")

        reconstructed["ReconstructedLevelEUR"] = reconstructed["ReconstructedLevel"] * reconstructed["USDEUR"]
        actual_series["IndexLevelEUR"] = actual_series["IndexLevel"] * actual_series["USDEUR"]

        recon_fig = go.Figure()
        recon_fig.add_trace(
            go.Scatter(
                x=reconstructed["Date"], y=reconstructed["ReconstructedLevel"], mode="lines", name="Reconstructed (USD)"
            )
        )
        recon_fig.add_trace(go.Scatter(x=actual_series["Date"], y=actual_series["IndexLevel"], mode="lines", name="Actual (USD)"))
        recon_fig.update_layout(
            title="Extended Reconstructed Index History (USD)", template="plotly_white", height=420
        )
        recon_fig.update_yaxes(type="log")

        recon_fx_fig = go.Figure()
        recon_fx_fig.add_trace(
            go.Scatter(
                x=reconstructed["Date"], y=reconstructed["ReconstructedLevelEUR"], mode="lines", name="Reconstructed (EUR)"
            )
        )
        recon_fx_fig.add_trace(
            go.Scatter(
                x=actual_series["Date"], y=actual_series["IndexLevelEUR"], mode="lines", name="Actual (EUR)"
            )
        )
        recon_fx_fig.update_layout(
            title="Extended Reconstructed Index History (EUR, Factor-Based Backcast)", template="plotly_white", height=420
        )
        recon_fx_fig.update_yaxes(type="log")

        result_export = reconstructed[["Date", "ReconstructedLevelEUR"]].copy()
        base_value = result_export["ReconstructedLevelEUR"].dropna().iloc[0]
        result_export["ReconstructedLevelEUR"] = (result_export["ReconstructedLevelEUR"] / base_value) * 100.0
        result_export = result_export.rename(columns={"ReconstructedLevelEUR": "CumulativePortfolioValueEUR"})
        result_export["Date"] = result_export["Date"].dt.strftime("%Y-%m-%d")

        freq_label = "daily" if daily else "monthly"
        extra = (
            " Portfolio levels are as-of merged to factor dates (forward-filled from last observation); "
            "with a monthly portfolio file, most daily returns are zero except around level updates."
            if daily
            else ""
        )
        status = (
            f"Regression completed on {len(ds)} {freq_label} observations. "
            f"Algorithm: {(regression_algo or 'ols').upper()}. "
            f"Factors used: {', '.join(factor_cols)}. "
            f"Factor source: {factor_label}. FX source: {fx_label}. Currency conversion: USD->EUR applied.{extra}"
        )
        return (
            status,
            cards,
            coef_out.to_dict("records"),
            exposure_fig,
            scatter_fig,
            residual_fig,
            cum_fig,
            recon_fig,
            recon_fx_fig,
            result_export.to_dict("records"),
        )
    except Exception as exc:
        msg = f"Error: {exc}"
        empty = make_empty_figure("Run regression to see chart.")
        return msg, [], [], empty, empty, empty, empty, empty, empty, None


@app.callback(
    Output("download-results", "data"),
    Input("download-btn", "n_clicks"),
    State("result-store", "data"),
    prevent_initial_call=True,
)
def download_results(_, data):
    if not data:
        return None
    out = pd.DataFrame(data)
    return dcc.send_data_frame(out.to_csv, "factor_regression_results.csv", index=False)


if __name__ == "__main__":
    app.run(debug=True)
