from factor_dashboard import app as dash_app

# Vercel Python runtime looks for a WSGI app object.
app = dash_app.server
