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


def parse_ff3_factors(raw: pd.DataFrame) -> pd.DataFrame:
    raw = raw.rename(columns={raw.columns[0]: "Date"})
    raw["Date"] = raw["Date"].astype(str).str.strip()
    monthly_rows = raw[raw["Date"].str.fullmatch(r"\d{6}", na=False)].copy()
    daily_rows = raw[raw["Date"].str.fullmatch(r"\d{8}", na=False)].copy()

    base_cols = ["Mkt-RF", "SMB", "HML", "RF"]
    optional_cols = [c for c in ["RMW", "CMA"] if c in raw.columns]
    cols = [*base_cols[:-1], *optional_cols, "RF"]

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


def load_ff3_factors(path: Path) -> pd.DataFrame:
    raw = pd.read_csv(path, skiprows=4)
    return parse_ff3_factors(raw)


def load_ff3_factors_from_content(contents: str, fallback_path: Path) -> tuple[pd.DataFrame, str]:
    if contents:
        _, content_string = contents.split(",", 1)
        decoded = base64.b64decode(content_string)
        raw = pd.read_csv(io.StringIO(decoded.decode("utf-8")), skiprows=4)
        return parse_ff3_factors(raw), "Uploaded factor file"
    return load_ff3_factors(fallback_path), fallback_path.name


def load_portfolio_prices_from_content(contents: str, fallback_path: Path) -> pd.DataFrame:
    if contents:
        _, content_string = contents.split(",", 1)
        decoded = base64.b64decode(content_string)
        df = pd.read_csv(io.StringIO(decoded.decode("utf-8")))
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
    out["Date"] = pd.to_datetime(out["Date"], format="%m/%Y", errors="coerce") + pd.offsets.MonthEnd(0)
    out["IndexLevel"] = pd.to_numeric(out["IndexLevel"], errors="coerce")
    out = out.dropna(subset=["Date", "IndexLevel"]).sort_values("Date")
    return out


def load_usd_eur_monthly_rates(path: Path) -> pd.DataFrame:
    fx = pd.read_csv(path, usecols=["date", "rate"])
    fx["Date"] = pd.to_datetime(fx["date"], errors="coerce") + pd.offsets.MonthEnd(0)
    fx["USDEUR"] = pd.to_numeric(fx["rate"], errors="coerce")
    fx = fx.dropna(subset=["Date", "USDEUR"]).sort_values("Date")
    # Keep one value per month, using latest daily quote.
    fx = fx.groupby("Date", as_index=False)["USDEUR"].last()
    return fx[["Date", "USDEUR"]]


def build_regression_dataset(contents: str, factor_contents: str, factor_choice: str) -> tuple[pd.DataFrame, str, list[str]]:
    if factor_choice == "uploaded":
        factors, factor_label = load_ff3_factors_from_content(factor_contents, FACTOR_FILE)
    else:
        factors, factor_label = load_ff3_factors(FACTOR_FILE), FACTOR_FILE.name
    portfolio = load_portfolio_prices_from_content(contents, DEFAULT_PORTFOLIO_FILE)
    portfolio["PortfolioReturn"] = portfolio["IndexLevel"].pct_change()
    portfolio = portfolio.dropna(subset=["PortfolioReturn"])

    merged = portfolio.merge(factors, on="Date", how="inner")
    if merged.empty:
        raise ValueError("No overlapping dates between portfolio and factor data.")

    factor_cols = [c for c in ["Mkt-RF", "SMB", "HML", "RMW", "CMA"] if c in merged.columns]
    merged["ExcessReturn"] = merged["PortfolioReturn"] - merged["RF"]
    merged = merged.dropna(subset=["ExcessReturn", *factor_cols]).sort_values("Date")
    return merged, factor_label, factor_cols


def run_factor_regression(dataset: pd.DataFrame, factor_cols: list[str]) -> tuple[pd.DataFrame, dict, np.ndarray, object]:
    x = dataset[factor_cols]
    y = dataset["ExcessReturn"]

    if len(dataset) < 24:
        raise ValueError("Not enough observations. Need at least 24 monthly points.")

    x_const = sm.add_constant(x)
    model = sm.OLS(y, x_const)
    results = model.fit()
    fitted = results.predict(x_const)

    coeff_table = pd.DataFrame(
        {
            "Term": results.params.index,
            "Coefficient": results.params.values,
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
        "Alpha (const)": float(results.params["const"]),
    }

    return coeff_table, metrics, fitted, results


def build_reconstructed_history(results, portfolio_prices: pd.DataFrame, factors: pd.DataFrame, factor_cols: list[str]) -> pd.DataFrame:
    factors = factors.copy()
    x_full = sm.add_constant(factors[factor_cols], has_constant="add")
    factors["PredExcess"] = results.predict(x_full)
    factors["PredReturn"] = factors["PredExcess"] + factors["RF"]

    anchor_row = portfolio_prices.dropna(subset=["Date", "IndexLevel"]).sort_values("Date").iloc[0]
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
        html.Div(
            style={"display": "flex", "gap": "10px", "alignItems": "center", "marginBottom": "10px"},
            children=[
                dcc.Dropdown(
                    id="factor-choice",
                    options=[
                        {"label": f"Default: {FACTOR_FILE.name}", "value": "default"},
                        {"label": "Use uploaded factor file", "value": "uploaded"},
                    ],
                    value="default",
                    clearable=False,
                    style={"minWidth": "300px"},
                ),
                dcc.DatePickerRange(id="date-range", display_format="YYYY-MM-DD"),
                html.Button("Run Regression", id="run-btn", n_clicks=0),
                html.Button("Download Results CSV", id="download-btn", n_clicks=0),
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
)
def refresh_date_bounds(contents, factor_contents, factor_choice):
    try:
        ds, _, _ = build_regression_dataset(contents, factor_contents, factor_choice)
        min_date = ds["Date"].min().date()
        max_date = ds["Date"].max().date()
        return min_date, max_date, min_date, max_date
    except Exception:
        return None, None, None, None


@app.callback(
    Output("portfolio-file-feedback", "children"),
    Output("factor-file-feedback", "children"),
    Input("portfolio-upload", "filename"),
    Input("factor-upload", "filename"),
    Input("factor-choice", "value"),
)
def show_selected_files(portfolio_filename, factor_filename, factor_choice):
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
    return portfolio_text, factor_text


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
    State("date-range", "start_date"),
    State("date-range", "end_date"),
    prevent_initial_call=True,
)
def run_analysis(_, contents, factor_contents, factor_choice, start_date, end_date):
    try:
        portfolio_prices = load_portfolio_prices_from_content(contents, DEFAULT_PORTFOLIO_FILE)
        ds, factor_label, factor_cols = build_regression_dataset(contents, factor_contents, factor_choice)
        factors = load_ff3_factors_from_content(factor_contents, FACTOR_FILE)[0] if factor_choice == "uploaded" else load_ff3_factors(FACTOR_FILE)
        fx_rates = load_usd_eur_monthly_rates(FX_FILE)
        if start_date and end_date:
            start = pd.to_datetime(start_date)
            end = pd.to_datetime(end_date)
            ds = ds[(ds["Date"] >= start) & (ds["Date"] <= end)].copy()

        coeff_table, metrics, fitted, results = run_factor_regression(ds, factor_cols)
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
        cum_fig.update_yaxes(type="log")

        reconstructed = build_reconstructed_history(results, portfolio_prices, factors, factor_cols)
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

        result_export = ds[["Date", "PortfolioReturn", "ExcessReturn", "FittedExcess", "Residual"]].copy()
        result_export = result_export.merge(
            reconstructed[["Date", "USDEUR", "ReconstructedLevel", "ReconstructedLevelEUR"]], on="Date", how="left"
        )
        result_export["Date"] = result_export["Date"].dt.strftime("%Y-%m-%d")

        status = (
            f"Regression completed on {len(ds)} monthly observations. "
            f"Factors used: {', '.join(factor_cols)}. "
            f"Factor source: {factor_label}. Currency conversion: USD->EUR applied."
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
