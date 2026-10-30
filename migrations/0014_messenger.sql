-- ===========================================================================
-- 0014 — Social Inbox › Facebook Messenger
-- ---------------------------------------------------------------------------
-- Real Messenger conversations between the workshop's Facebook Page and its
-- customers, written by the Meta webhook (POST /api/webhooks/messenger) and by
-- staff replies sent through the Send API. Additive only.
--
-- messenger_conversations  one row per customer (Page-scoped ID, "PSID") per
--                          Page: FBC-0001, from id_counters.
-- messenger_messages       every message in either direction, never deleted.
--                          INTEGER ids: a high-volume log, like activity_log.
--
-- No access token, app secret or verify token is ever stored here; they are
-- Worker secrets. Nothing deletes a message: the foreign key RESTRICTs
-- removing a conversation that has any.
--
-- Duplicate webhook deliveries (Meta retries) are absorbed by the unique
-- index on the platform message id ("mid"); a staff reply sent twice from a
-- retried request is absorbed by the unique (conversation, client request id).
-- ===========================================================================

CREATE TABLE IF NOT EXISTS messenger_conversations (
  id                    TEXT PRIMARY KEY,                       -- 'FBC-0001', from id_counters
  page_id               TEXT NOT NULL CHECK (length(page_id) BETWEEN 1 AND 40),
  customer_psid         TEXT NOT NULL CHECK (length(customer_psid) BETWEEN 1 AND 40),
  customer_name         TEXT CHECK (customer_name IS NULL OR length(customer_name) <= 120),
  customer_profile_pic  TEXT CHECK (customer_profile_pic IS NULL OR length(customer_profile_pic) <= 1000),
  status                TEXT NOT NULL DEFAULT 'Open' CHECK (status IN ('Open', 'Pending', 'Resolved')),
  unread_count          INTEGER NOT NULL DEFAULT 0 CHECK (unread_count >= 0),
  last_message          TEXT CHECK (last_message IS NULL OR length(last_message) <= 300),
  last_message_at       TEXT,
  last_direction        TEXT CHECK (last_direction IS NULL OR last_direction IN ('in', 'out')),
  -- When the customer last wrote: Meta's standard messaging window runs from here.
  last_inbound_at       TEXT,
  assigned_to           TEXT CHECK (assigned_to IS NULL OR length(assigned_to) <= 100),
  notes                 TEXT CHECK (notes IS NULL OR length(notes) <= 2000),
  created_at            TEXT NOT NULL,
  updated_at            TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_msc_page_customer ON messenger_conversations(page_id, customer_psid);
CREATE INDEX IF NOT EXISTS ix_msc_last ON messenger_conversations(last_message_at, id);
CREATE INDEX IF NOT EXISTS ix_msc_status ON messenger_conversations(status);

CREATE TABLE IF NOT EXISTS messenger_messages (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id       TEXT NOT NULL REFERENCES messenger_conversations(id) ON DELETE RESTRICT,
  platform_message_id   TEXT CHECK (platform_message_id IS NULL OR length(platform_message_id) BETWEEN 1 AND 200),
  direction             TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  -- customer: the customer wrote; staff: sent from Taqwa Autos; page: sent from
  -- the Page in another tool (Meta Business Suite), seen as a message echo.
  sender_type           TEXT NOT NULL CHECK (sender_type IN ('customer', 'staff', 'page')),
  sender_id             TEXT CHECK (sender_id IS NULL OR length(sender_id) <= 40),
  sent_by               TEXT CHECK (sent_by IS NULL OR length(sent_by) <= 100),
  kind                  TEXT NOT NULL DEFAULT 'message' CHECK (kind IN ('message', 'postback')),
  message_text          TEXT CHECK (message_text IS NULL OR length(message_text) <= 20000),
  attachments_json      TEXT CHECK (attachments_json IS NULL OR (json_valid(attachments_json) AND length(attachments_json) <= 20000)),
  status                TEXT NOT NULL CHECK (status IN ('received', 'sending', 'sent', 'delivered', 'read', 'failed')),
  error_code            TEXT CHECK (error_code IS NULL OR length(error_code) <= 40),
  error_message         TEXT CHECK (error_message IS NULL OR length(error_message) <= 300),
  client_request_id     TEXT CHECK (client_request_id IS NULL OR length(client_request_id) BETWEEN 8 AND 64),
  platform_timestamp    INTEGER,                                -- Meta's event time, ms since the epoch
  created_at            TEXT NOT NULL,
  updated_at            TEXT,

  CHECK ((direction = 'in') = (sender_type = 'customer')),
  CHECK (direction = 'out' OR status = 'received'),
  CHECK (direction = 'in' OR status <> 'received')
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_msm_platform_id
  ON messenger_messages(platform_message_id) WHERE platform_message_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_msm_client_request
  ON messenger_messages(conversation_id, client_request_id) WHERE client_request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_msm_conversation ON messenger_messages(conversation_id, id);

INSERT OR IGNORE INTO id_counters (collection, prefix, last_value) VALUES ('messengerConversations', 'FBC', 0);
