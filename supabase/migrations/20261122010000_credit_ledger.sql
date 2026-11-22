-- Territory HQ — transactional booking and immutable credit ledger (additive phase).
--
-- This migration is deliberately staged. It adds columns, tables, indexes and
-- write-time guards without converting legacy DOUBLE PRECISION values, text
-- dates/times, or malformed rows. Existing rows are left readable and existing
-- balances are untouched. The deployment preflight is documented at
-- docs/credit-ledger-deployment-preflight.md and lists the read-only reports and
-- reconciliation required before validating constraints or considering
-- btree_gist/exclusion constraints. The quote guard permits exactly one
-- all-NULL-to-complete legacy quote backfill via fill_legacy_booking_quote(),
-- then makes every quote snapshot immutable.
--
-- New application writes use the typed columns (amount_numeric,
-- credits_charged_numeric, duration_hours_numeric and the quote_* columns) and
-- keep the legacy columns as display-compatible snapshots.

-- ---------------------------------------------------------------------------
-- Credits: append-only ledger metadata and staged numeric amounts.
-- ---------------------------------------------------------------------------
ALTER TABLE public.credits
  ADD COLUMN IF NOT EXISTS amount_numeric NUMERIC(14,2),
  ADD COLUMN IF NOT EXISTS entry_type TEXT,
  ADD COLUMN IF NOT EXISTS booking_id TEXT,
  ADD COLUMN IF NOT EXISTS source_id TEXT,
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT,
  ADD COLUMN IF NOT EXISTS reverses_credit_id TEXT,
  ADD COLUMN IF NOT EXISTS actor_type TEXT,
  ADD COLUMN IF NOT EXISTS actor_id TEXT,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.credits ALTER COLUMN created_at SET DEFAULT now();

-- New writes must use one of the documented ledger entry types. NOT VALID keeps
-- legacy rows readable until the preflight classifies them.
ALTER TABLE public.credits DROP CONSTRAINT IF EXISTS credits_entry_type_check;
ALTER TABLE public.credits ADD CONSTRAINT credits_entry_type_check
  CHECK (entry_type IS NULL OR entry_type IN
    ('grant', 'adjustment', 'booking_charge', 'booking_refund', 'migration'))
  NOT VALID;

ALTER TABLE public.credits DROP CONSTRAINT IF EXISTS credits_amount_numeric_check;
ALTER TABLE public.credits ADD CONSTRAINT credits_amount_numeric_check
  CHECK (amount_numeric IS NULL OR (amount_numeric <> 0 AND amount_numeric = round(amount_numeric, 2)))
  NOT VALID;

ALTER TABLE public.credits DROP CONSTRAINT IF EXISTS credits_booking_entry_shape_check;
ALTER TABLE public.credits ADD CONSTRAINT credits_booking_entry_shape_check
  CHECK (
    entry_type IS NULL
    OR entry_type NOT IN ('booking_charge', 'booking_refund')
    OR (
      booking_id IS NOT NULL
      AND (
        (entry_type = 'booking_charge' AND amount_numeric < 0)
        OR (entry_type = 'booking_refund' AND amount_numeric > 0 AND reverses_credit_id IS NOT NULL)
      )
    )
  )
  NOT VALID;

CREATE UNIQUE INDEX IF NOT EXISTS credits_booking_entry_unique
  ON public.credits (user_id, booking_id, entry_type)
  WHERE booking_id IS NOT NULL
    AND entry_type IN ('booking_charge', 'booking_refund');

CREATE UNIQUE INDEX IF NOT EXISTS credits_idempotency_unique
  ON public.credits (user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS credits_owner_account_created_idx
  ON public.credits (user_id, account_id, created_at, id);

CREATE OR REPLACE FUNCTION public.immutable_credits_guard()
RETURNS trigger
LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'credits is an append-only ledger'
    USING ERRCODE = '23514';
END;
$$;

DROP TRIGGER IF EXISTS immutable_credits ON public.credits;
CREATE TRIGGER immutable_credits
  BEFORE UPDATE OR DELETE ON public.credits
  FOR EACH ROW EXECUTE FUNCTION public.immutable_credits_guard();

-- A refund may only reverse a charge for the same owner/account/booking and
-- must be its exact numeric inverse. Legacy rows with no entry_type are ignored.
CREATE OR REPLACE FUNCTION public.enforce_booking_refund_guard()
RETURNS trigger
LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
DECLARE
  charge public.credits%ROWTYPE;
BEGIN
  IF NEW.entry_type IS DISTINCT FROM 'booking_refund' THEN
    RETURN NEW;
  END IF;
  IF NEW.reverses_credit_id IS NULL OR NEW.booking_id IS NULL THEN
    RAISE EXCEPTION 'booking refund must name its original charge and booking'
      USING ERRCODE = '23514';
  END IF;
  SELECT * INTO charge FROM public.credits WHERE id = NEW.reverses_credit_id FOR SHARE;
  IF NOT FOUND OR charge.entry_type IS DISTINCT FROM 'booking_charge' THEN
    RAISE EXCEPTION 'booking refund must reverse a booking charge'
      USING ERRCODE = '23514';
  END IF;
  IF charge.booking_id IS DISTINCT FROM NEW.booking_id
     OR charge.user_id IS DISTINCT FROM NEW.user_id
     OR charge.account_id IS DISTINCT FROM NEW.account_id THEN
    RAISE EXCEPTION 'booking refund must match the charge owner, account and booking'
      USING ERRCODE = '23514';
  END IF;
  IF charge.amount_numeric IS NULL
     OR NEW.amount_numeric IS NULL
     OR NEW.amount_numeric <> -charge.amount_numeric THEN
    RAISE EXCEPTION 'booking refund must exactly negate the original charge'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_booking_refund ON public.credits;
CREATE TRIGGER enforce_booking_refund
  BEFORE INSERT OR UPDATE ON public.credits
  FOR EACH ROW EXECUTE FUNCTION public.enforce_booking_refund_guard();

-- ---------------------------------------------------------------------------
-- Bookings: immutable quote snapshots, typed money, audit timestamps and state.
-- ---------------------------------------------------------------------------
ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS quoted_credits NUMERIC(14,2),
  ADD COLUMN IF NOT EXISTS quote_base_hours NUMERIC(8,2),
  ADD COLUMN IF NOT EXISTS quote_base_credits NUMERIC(14,2),
  ADD COLUMN IF NOT EXISTS quote_extra_hour_credits NUMERIC(14,2),
  ADD COLUMN IF NOT EXISTS requested_by_portal_user_id TEXT,
  ADD COLUMN IF NOT EXISTS created_by_actor_type TEXT,
  ADD COLUMN IF NOT EXISTS created_by_actor_id TEXT,
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS declined_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS status_changed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS duration_hours_numeric NUMERIC(8,2),
  ADD COLUMN IF NOT EXISTS credits_charged_numeric NUMERIC(14,2);

ALTER TABLE public.bookings DROP CONSTRAINT IF EXISTS bookings_status_check;
ALTER TABLE public.bookings ADD CONSTRAINT bookings_status_check
  CHECK (status IN (
    'requested', 'approved', 'confirmed', 'declined', 'cancelled', 'completed'
  ))
  NOT VALID;

ALTER TABLE public.bookings DROP CONSTRAINT IF EXISTS bookings_quote_positive_check;
ALTER TABLE public.bookings ADD CONSTRAINT bookings_quote_positive_check
  CHECK (quoted_credits IS NULL OR quoted_credits > 0)
  NOT VALID;

CREATE INDEX IF NOT EXISTS bookings_owner_status_date_idx
  ON public.bookings (owner_user_id, status, date, start_time);

CREATE INDEX IF NOT EXISTS bookings_owner_account_date_idx
  ON public.bookings (owner_user_id, account_id, date);

CREATE INDEX IF NOT EXISTS bookings_owner_ambassador_date_idx
  ON public.bookings (owner_user_id, ambassador_user_id, date)
  WHERE ambassador_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS event_types_owner_active_name_idx
  ON public.event_types (owner_user_id, active, name);

CREATE INDEX IF NOT EXISTS portal_users_owner_role_status_idx
  ON public.portal_users (owner_user_id, id, role, status);

CREATE OR REPLACE FUNCTION public.immutable_booking_quote_guard()
RETURNS trigger
LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id
     OR NEW.account_id IS DISTINCT FROM OLD.account_id
     OR NEW.event_type_id IS DISTINCT FROM OLD.event_type_id
     OR NEW.event_type_name IS DISTINCT FROM OLD.event_type_name
     OR NEW.date IS DISTINCT FROM OLD.date
     OR NEW.start_time IS DISTINCT FROM OLD.start_time
     OR NEW.duration_hours IS DISTINCT FROM OLD.duration_hours
     OR NEW.duration_hours_numeric IS DISTINCT FROM OLD.duration_hours_numeric
     OR NEW.requested_by_portal_user_id IS DISTINCT FROM OLD.requested_by_portal_user_id
     OR NEW.created_by_actor_type IS DISTINCT FROM OLD.created_by_actor_type
     OR NEW.created_by_actor_id IS DISTINCT FROM OLD.created_by_actor_id THEN
    RAISE EXCEPTION 'booking quote snapshots are immutable'
      USING ERRCODE = '23514';
  END IF;

  -- Allow one-time legacy quote backfill: all four snapshots start NULL and
  -- are completed together. Afterwards OLD values are non-NULL, so this branch
  -- cannot run again and every later quote change is rejected.
  IF OLD.quoted_credits IS NULL
     AND OLD.quote_base_hours IS NULL
     AND OLD.quote_base_credits IS NULL
     AND OLD.quote_extra_hour_credits IS NULL
     AND NEW.quoted_credits IS NOT NULL
     AND NEW.quote_base_hours IS NOT NULL
     AND NEW.quote_base_credits IS NOT NULL
     AND NEW.quote_extra_hour_credits IS NOT NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.quoted_credits IS DISTINCT FROM OLD.quoted_credits
     OR NEW.quote_base_hours IS DISTINCT FROM OLD.quote_base_hours
     OR NEW.quote_base_credits IS DISTINCT FROM OLD.quote_base_credits
     OR NEW.quote_extra_hour_credits IS DISTINCT FROM OLD.quote_extra_hour_credits THEN
    RAISE EXCEPTION 'booking quote snapshots are immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.fill_legacy_booking_quote(
  p_booking_id TEXT,
  p_quoted_credits NUMERIC,
  p_base_hours NUMERIC,
  p_base_credits NUMERIC,
  p_extra_hour_credits NUMERIC
) RETURNS boolean
LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE public.bookings
     SET quoted_credits = p_quoted_credits,
         quote_base_hours = p_base_hours,
         quote_base_credits = p_base_credits,
         quote_extra_hour_credits = p_extra_hour_credits
   WHERE id = p_booking_id
     AND quoted_credits IS NULL
     AND quote_base_hours IS NULL
     AND quote_base_credits IS NULL
     AND quote_extra_hour_credits IS NULL;
  RETURN FOUND;
END;
$$;

DROP TRIGGER IF EXISTS immutable_booking_quote ON public.bookings;
CREATE TRIGGER immutable_booking_quote
  BEFORE UPDATE ON public.bookings
  FOR EACH ROW EXECUTE FUNCTION public.immutable_booking_quote_guard();

CREATE OR REPLACE FUNCTION public.enforce_booking_transition_guard()
RETURNS trigger
LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF OLD.status = 'requested'
       AND NEW.status IN ('approved', 'declined', 'cancelled') THEN
      RETURN NEW;
    ELSIF OLD.status = 'approved'
          AND NEW.status IN ('confirmed', 'cancelled', 'approved') THEN
      RETURN NEW;
    ELSIF OLD.status = 'confirmed'
          AND NEW.status IN ('cancelled', 'completed', 'approved') THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'invalid booking transition: % -> %', OLD.status, NEW.status
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_booking_transition ON public.bookings;
CREATE TRIGGER enforce_booking_transition
  BEFORE UPDATE ON public.bookings
  FOR EACH ROW EXECUTE FUNCTION public.enforce_booking_transition_guard();

-- ---------------------------------------------------------------------------
-- Append-only audit records and idempotency responses.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.booking_events (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  booking_id TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT NOT NULL,
  action TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  request_id TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS booking_events_owner_booking_created_idx
  ON public.booking_events (owner_user_id, booking_id, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS booking_events_request_unique
  ON public.booking_events (owner_user_id, request_id, action)
  WHERE request_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.api_idempotency (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_status INTEGER,
  response_body JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  UNIQUE (owner_user_id, actor_type, actor_id, operation, idempotency_key)
);

CREATE INDEX IF NOT EXISTS api_idempotency_created_at_idx
  ON public.api_idempotency (created_at);

-- New tables must receive the same Data API protection as the existing app
-- tables. Skip absent tables so partial installs remain runnable.
DO $$
DECLARE
  app_table text;
  api_roles text;
BEGIN
  SELECT string_agg(format('%I', rolname), ', ' ORDER BY rolname)
    INTO api_roles
    FROM pg_catalog.pg_roles
   WHERE rolname IN ('anon', 'authenticated');

  FOREACH app_table IN ARRAY ARRAY['booking_events', 'api_idempotency']::text[]
  LOOP
    IF to_regclass(format('public.%I', app_table)) IS NULL THEN
      CONTINUE;
    END IF;
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', app_table);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', app_table);
    IF api_roles IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %s', app_table, api_roles);
    END IF;
  END LOOP;
END
$$;

COMMENT ON TABLE public.credits IS
  'Append-only credit ledger. Legacy amount remains for compatibility; numeric writes use amount_numeric.';
COMMENT ON TABLE public.bookings IS
  'Booking quote snapshots are immutable after insertion. Typed numeric shadows are staged for legacy rows.';
COMMENT ON TABLE public.api_idempotency IS
  'Owner-scoped API replay records. Retain until the client retry horizon has expired.';
