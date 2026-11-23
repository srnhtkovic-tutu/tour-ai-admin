-- ページ抽出Workerの上限（200件）と、施設名候補登録RPCの上限を一致させる。
-- 施設名候補を切り捨てず、抽出結果をそのまま登録できるようにする。

CREATE OR REPLACE FUNCTION private.commit_spot_import_analysis_batch(
  p_job_id uuid,
  p_execution_id uuid,
  p_lock_token uuid,
  p_url_id uuid,
  p_success boolean,
  p_candidates jsonb DEFAULT '[]'::jsonb,
  p_error text DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
declare
  v_count integer := 0;
  v_item jsonb;
  v_name text;
  v_name_key text;
  v_exists boolean;
begin
  perform private.assert_spot_import_execution(
    p_job_id, p_execution_id, p_lock_token, 'candidate_analysis'
  );

  perform 1
  from public.spot_import_urls u
  where u.id = p_url_id
    and u.job_id = p_job_id
    and u.processing_execution_id = p_execution_id
    and u.analysis_status = 'processing'
  for update;

  if not found then
    raise exception 'url_not_claimed_by_execution';
  end if;

  if p_success then
    if jsonb_typeof(coalesce(p_candidates, '[]'::jsonb)) <> 'array'
       or jsonb_array_length(coalesce(p_candidates, '[]'::jsonb)) > 200 then
      raise exception 'invalid_analysis_payload';
    end if;

    for v_item in
      select value from jsonb_array_elements(coalesce(p_candidates, '[]'::jsonb))
    loop
      if nullif(btrim(v_item->>'name'), '') is null then
        raise exception 'candidate_name_required';
      end if;

      v_name := left(btrim(v_item->>'name'), 500);
      v_name_key := lower(
        regexp_replace(normalize(v_name, NFKC), '[[:space:]]+', '', 'g')
      );

      select exists (
        select 1
        from public.spot_import_candidates c
        where c.job_id = p_job_id
          and lower(
            regexp_replace(normalize(btrim(c.name), NFKC), '[[:space:]]+', '', 'g')
          ) = v_name_key
      ) into v_exists;

      if not v_exists then
        insert into public.spot_import_candidates (
          job_id, source_url_id, name, address, official_url, description,
          best_season, catch_copy, top_reason, highlight_points, tags, raw_data,
          review_status, registration_status
        )
        values (
          p_job_id,
          p_url_id,
          v_name,
          nullif(v_item->>'address', ''),
          nullif(v_item->>'official_url', ''),
          nullif(v_item->>'description', ''),
          nullif(v_item->>'best_season', ''),
          nullif(v_item->>'catch_copy', ''),
          nullif(v_item->>'top_reason', ''),
          coalesce(v_item->'highlight_points', '[]'::jsonb),
          coalesce(v_item->'tags', '[]'::jsonb),
          coalesce(v_item->'raw_data', '{}'::jsonb),
          'pending',
          'pending'
        );

        v_count := v_count + 1;
      end if;
    end loop;

    update public.spot_import_urls
    set analysis_status = 'completed',
        analysis_error = null,
        processing_execution_id = null,
        updated_at = now()
    where id = p_url_id and job_id = p_job_id;
  else
    update public.spot_import_urls
    set analysis_status = 'failed',
        analysis_error = left(coalesce(p_error, 'analysis_failed'), 2000),
        processing_execution_id = null,
        updated_at = now()
    where id = p_url_id and job_id = p_job_id;
  end if;

  return v_count;
end;
$function$;
