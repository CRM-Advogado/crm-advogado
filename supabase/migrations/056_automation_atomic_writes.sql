-- Parent rows and step trees must commit or roll back together.
-- These RPCs are called only after the server validates the request.
CREATE OR REPLACE FUNCTION public.create_automation_trees(
  p_account_id uuid,
  p_user_id uuid,
  p_automations jsonb
)
RETURNS SETOF public.automations
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  input jsonb;
  created public.automations;
BEGIN
  PERFORM 1 FROM public.profiles
  WHERE user_id = p_user_id AND account_id = p_account_id
    AND account_role IN ('owner', 'admin', 'agent')
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'automation_account_not_authorized' USING ERRCODE = '42501';
  END IF;

  FOR input IN SELECT value FROM jsonb_array_elements(p_automations)
  LOOP
    INSERT INTO public.automations (
      account_id, user_id, name, description, trigger_type, trigger_config, is_active
    ) VALUES (
      p_account_id, p_user_id, input->>'name', input->>'description',
      input->>'trigger_type', input->'trigger_config', (input->>'is_active')::boolean
    ) RETURNING * INTO created;

    INSERT INTO public.automation_steps (
      id, automation_id, parent_step_id, branch, step_type, step_config, position
    )
    SELECT step.id, created.id, step.parent_step_id, step.branch,
      step.step_type, step.step_config, step.position
    FROM jsonb_to_recordset(input->'steps') AS step(
      id uuid, parent_step_id uuid, branch text, step_type text, step_config jsonb, position integer
    );

    RETURN NEXT created;
  END LOOP;
  RETURN;
END;
$$;

CREATE OR REPLACE FUNCTION public.update_automation_tree(
  p_account_id uuid,
  p_user_id uuid,
  p_id uuid,
  p_expected_updated_at timestamptz,
  p_fields jsonb,
  p_steps jsonb
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  PERFORM 1 FROM public.profiles
  WHERE user_id = p_user_id AND account_id = p_account_id
    AND account_role IN ('owner', 'admin', 'agent')
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'automation_account_not_authorized' USING ERRCODE = '42501';
  END IF;

  -- Updating the parent locks it and rejects a stale validation snapshot.
  UPDATE public.automations AS automation
  SET
    name = COALESCE(p_fields->>'name', automation.name),
    description = CASE WHEN p_fields ? 'description'
      THEN p_fields->>'description' ELSE automation.description END,
    trigger_type = COALESCE(p_fields->>'trigger_type', automation.trigger_type),
    trigger_config = COALESCE(p_fields->'trigger_config', automation.trigger_config),
    is_active = COALESCE((p_fields->>'is_active')::boolean, automation.is_active)
  WHERE automation.id = p_id AND automation.account_id = p_account_id
    AND automation.user_id = p_user_id
    AND automation.updated_at = p_expected_updated_at;

  IF NOT FOUND THEN RETURN false; END IF;

  IF p_steps IS NOT NULL THEN
    DELETE FROM public.automation_steps WHERE automation_id = p_id;

    INSERT INTO public.automation_steps (
      id, automation_id, parent_step_id, branch, step_type, step_config, position
    )
    SELECT step.id, p_id, step.parent_step_id, step.branch,
      step.step_type, step.step_config, step.position
    FROM jsonb_to_recordset(p_steps) AS step(
      id uuid, parent_step_id uuid, branch text, step_type text, step_config jsonb, position integer
    );
  END IF;

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.create_automation_trees(uuid, uuid, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_automation_trees(uuid, uuid, jsonb) TO service_role;

REVOKE ALL ON FUNCTION public.update_automation_tree(uuid, uuid, uuid, timestamptz, jsonb, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_automation_tree(uuid, uuid, uuid, timestamptz, jsonb, jsonb)
  TO service_role;
