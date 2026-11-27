-- Add a durable parent-child relationship between production spots.
-- Existing records remain unchanged (NULL type, no parent) until manually reviewed.

alter table public.spots
  add column if not exists spot_type text,
  add column if not exists parent_spot_id bigint;

do $$
begin
  if not exists (select 1 from pg_constraint where conname='spots_spot_type_check' and conrelid='public.spots'::regclass) then
    alter table public.spots add constraint spots_spot_type_check
      check (spot_type is null or spot_type in ('independent_facility','nested_spot','standalone_spot'));
  end if;
  if not exists (select 1 from pg_constraint where conname='spots_parent_not_self_check' and conrelid='public.spots'::regclass) then
    alter table public.spots add constraint spots_parent_not_self_check
      check (parent_spot_id is null or parent_spot_id <> id);
  end if;
  if not exists (select 1 from pg_constraint where conname='spots_parent_spot_id_fkey' and conrelid='public.spots'::regclass) then
    alter table public.spots add constraint spots_parent_spot_id_fkey
      foreign key (parent_spot_id) references public.spots(id) on delete restrict;
  end if;
  if not exists (select 1 from pg_constraint where conname='spots_parent_type_consistency_check' and conrelid='public.spots'::regclass) then
    alter table public.spots add constraint spots_parent_type_consistency_check
      check (
        (spot_type='nested_spot' and parent_spot_id is not null)
        or (spot_type is distinct from 'nested_spot' and parent_spot_id is null)
      );
  end if;
end; $$;

create index if not exists spots_parent_spot_id_idx
  on public.spots(parent_spot_id) where parent_spot_id is not null;

CREATE OR REPLACE FUNCTION public.approve_spot_import_review(p_candidate_id uuid)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_candidate public.spot_import_merged_v2%rowtype;
  v_region uuid;
  v_data jsonb;
  v_guide jsonb;
  v_name text;
  v_spot_id bigint;
  v_lat double precision;
  v_lng double precision;
  v_geocoding jsonb;
  v_spot_type text;
  v_parent_spot_id bigint;
begin
  if auth.uid() is null then raise exception 'ログインが必要です'; end if;
  select * into v_candidate from public.spot_import_merged_v2 where id=p_candidate_id for update;
  if not found then raise exception '審査候補が見つかりません'; end if;
  if v_candidate.review_status<>'pending' then raise exception 'この候補は別の担当者によって処理済みです。画面を更新してください'; end if;
  if v_candidate.status<>'completed' or v_candidate.merged_data->>'decision'<>'accepted' then raise exception 'この候補は審査対象ではありません'; end if;
  select region_id into v_region from public.spot_import_jobs where id=v_candidate.job_id;
  if not found then raise exception '元の収集ジョブが見つかりません'; end if;
  if not (private.is_system_admin() or private.has_region_access(v_region)) then raise exception 'この地域の承認権限がありません'; end if;
  if not exists(select 1 from public.regions where id=v_region and is_active) then raise exception '無効な地域の候補は承認できません'; end if;
  v_data:=coalesce(v_candidate.reviewed_data,v_candidate.merged_data);
  if v_data is null then raise exception '審査データがありません'; end if;
  v_name:=trim(coalesce(v_data->>'name',v_candidate.spot_name));
  v_spot_type:=coalesce(nullif(v_data->>'spot_type',''),'undetermined');
  v_parent_spot_id:=nullif(v_data->>'parent_spot_id','')::bigint;
  v_guide:=coalesce(v_data->'guide_data','{}'::jsonb);
  v_geocoding:=case when jsonb_typeof(v_data->'geocoding')='object' then v_data->'geocoding' else jsonb_build_object('provider','manual_review') end;
  if v_name='' or length(v_name)>100 then raise exception 'スポット名は1〜100文字で入力してください'; end if;
  if v_spot_type not in ('independent_facility','nested_spot','standalone_spot') then
    raise exception 'スポットの種類を選択してください';
  end if;
  if v_spot_type='nested_spot' and v_parent_spot_id is null then
    raise exception '施設内スポットには親施設を選択してください';
  end if;
  if v_spot_type<>'nested_spot' and v_parent_spot_id is not null then
    raise exception '親施設を設定できるのは施設内スポットだけです';
  end if;
  if v_parent_spot_id is not null and not exists (
    select 1 from public.spots p
    where p.id=v_parent_spot_id and p.region_id=v_region
      and (p.spot_type is null or p.spot_type='independent_facility')
  ) then
    raise exception '親施設は同じ地域に本番登録済みの独立施設から選択してください';
  end if;
  if length(coalesce(v_data->>'address',''))>200 then raise exception '住所は200文字以内で入力してください'; end if;
  if jsonb_typeof(v_guide)<>'object' then raise exception '紹介情報の形式が正しくありません'; end if;
  if coalesce(length(v_guide->>'officialUrl'),0)>2000 then raise exception '公式サイトURLは2000文字以内で入力してください'; end if;
  if exists(select 1 from jsonb_each_text(v_guide) e where e.key in ('catchCopy','topReason','bestSeason','latestTopics','recommendFood','recommendHistory','recommendRelax','recommendActivity','localRecommendation') and length(e.value)>2000) then raise exception '紹介文は各項目2000文字以内で入力してください'; end if;
  v_lat:=nullif(v_data->>'lat','')::double precision;
  v_lng:=nullif(v_data->>'lng','')::double precision;
  if (v_lat is null)<>(v_lng is null) then raise exception '緯度と経度は両方入力してください'; end if;
  if v_lat is null or v_lng is null then raise exception '位置情報が未設定です。緯度・経度を設定してから承認してください'; end if;
  if v_lat < -90 or v_lat>90 or v_lng < -180 or v_lng>180 then raise exception '緯度・経度の範囲が正しくありません'; end if;
  v_geocoding:=v_geocoding||jsonb_build_object(
    'approved_lat',v_lat,
    'approved_lng',v_lng,
    'location_source',coalesce(v_data->>'location_source','manual_review')
  );
  insert into public.spots(name,address,lat,lng,guide_data,region_id,geocoding_data,spot_type,parent_spot_id)
  values(v_name,nullif(trim(v_data->>'address'),''),v_lat,v_lng,v_guide,v_region,v_geocoding,v_spot_type,v_parent_spot_id)
  returning id into v_spot_id;
  insert into public.spot_operation_logs(region_id,spot_id,spot_name,operation_type,actor_user_id,details)
  values(v_region,v_spot_id,v_name,'approve',auth.uid(),jsonb_build_object('source','ai_review','candidate_id',p_candidate_id,'geocoding',v_geocoding,'spot_type',v_spot_type,'parent_spot_id',v_parent_spot_id));
  update public.spot_import_merged_v2 set review_status='approved',reviewed_by=auth.uid(),reviewed_at=now(),approved_spot_id=v_spot_id,updated_at=now() where id=p_candidate_id;
  return v_spot_id;
end;
$function$;
