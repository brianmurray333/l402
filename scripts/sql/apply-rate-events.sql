-- API submission IP rate events (serverless-safe throttling)
CREATE TABLE IF NOT EXISTS api_submission_rate_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_ip TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_api_sub_rate_ip_time ON api_submission_rate_events (client_ip, created_at DESC);

ALTER TABLE api_submission_rate_events ENABLE ROW LEVEL SECURITY;
