from prometheus_client import Counter, Histogram

connector_requests_total = Counter(
    "smartflo_connector_requests_total",
    "Total ConnectTwilioCall requests",
    ["direction", "status"],
)

connector_latency_seconds = Histogram(
    "smartflo_connector_latency_seconds",
    "ConnectTwilioCall API latency",
    buckets=(0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0),
)
