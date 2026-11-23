
alter table public.spots
  add column if not exists geocoding_data jsonb;

create or replace function public.approve_spot_import_review(p_candidate_id uuid)
returns bigint
language plpgsql
security definer
set search_path to ''
as $function$
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
  v_guide:=coalesce(v_data->'guide_data','{}'::jsonb);
  v_geocoding:=v_data->'geocoding';
  if v_name='' or length(v_name)>100 then raise exception 'スポット名は1〜100文字で入力してください'; end if;
  if length(coalesce(v_data->>'address',''))>200 then raise exception '住所は200文字以内で入力してください'; end if;
  if jsonb_typeof(v_guide)<>'object' then raise exception '紹介情報の形式が正しくありません'; end if;
  if coalesce(length(v_guide->>'officialUrl'),0)>2000 then raise exception '公式サイトURLは2000文字以内で入力してください'; end if;
  if exists(select 1 from jsonb_each_text(v_guide) e where e.key in ('catchCopy','topReason','bestSeason','latestTopics','recommendFood','recommendHistory','recommendRelax','recommendActivity','localRecommendation') and length(e.value)>2000) then raise exception '紹介文は各項目2000文字以内で入力してください'; end if;
  v_lat:=nullif(v_data->>'lat','')::double precision;
  v_lng:=nullif(v_data->>'lng','')::double precision;
  if (v_lat is null)<>(v_lng is null) then raise exception '緯度と経度は両方入力してください'; end if;
  if v_lat is null or v_lng is null then raise exception '位置情報が未設定です。緯度・経度を設定してから承認してください'; end if;
  if v_lat < -90 or v_lat>90 or v_lng < -180 or v_lng>180 then raise exception '緯度・経度の範囲が正しくありません'; end if;
  insert into public.spots(name,address,lat,lng,guide_data,region_id,geocoding_data)
  values(v_name,nullif(trim(v_data->>'address'),''),v_lat,v_lng,v_guide,v_region,v_geocoding)
  returning id into v_spot_id;
  insert into public.spot_operation_logs(region_id,spot_id,spot_name,operation_type,actor_user_id,details)
  values(v_region,v_spot_id,v_name,'approve',auth.uid(),jsonb_build_object('source','ai_review','candidate_id',p_candidate_id,'geocoding',v_geocoding));
  update public.spot_import_merged_v2 set review_status='approved',reviewed_by=auth.uid(),reviewed_at=now(),approved_spot_id=v_spot_id,updated_at=now() where id=p_candidate_id;
  return v_spot_id;
end;
$function$;

create or replace function public.update_region_spot(
  p_spot_id bigint,
  p_name text,
  p_address text,
  p_lat double precision,
  p_lng double precision,
  p_guide_data jsonb
)
returns void
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_region uuid;
  v_old_name text;
begin
  if auth.uid() is null then raise exception 'ログインが必要です'; end if;
  select region_id,name into v_region,v_old_name from public.spots where id=p_spot_id;
  if not found then raise exception '対象スポットが見つかりません'; end if;
  if not (private.is_system_admin() or private.has_region_access(v_region)) then raise exception 'このスポットを編集する権限がありません'; end if;
  if p_name is null or length(trim(p_name))=0 or length(p_name)>100 then raise exception 'スポット名は1〜100文字で入力してください'; end if;
  if p_address is not null and length(p_address)>200 then raise exception '住所は200文字以内で入力してください'; end if;
  if p_guide_data is not null and jsonb_typeof(p_guide_data)<>'object' then raise exception '紹介情報の形式が正しくありません'; end if;
  if coalesce(length(p_guide_data->>'officialUrl'),0)>2000 then raise exception '公式サイトURLは2000文字以内で入力してください'; end if;
  if exists(select 1 from jsonb_each_text(coalesce(p_guide_data,'{}'::jsonb)) e where e.key in ('catchCopy','topReason','bestSeason','latestTopics','recommendFood','recommendHistory','recommendRelax','recommendActivity','localRecommendation') and length(e.value)>2000) then raise exception '紹介文は各項目2000文字以内で入力してください'; end if;
  update public.spots
  set name=trim(p_name),
      address=nullif(trim(p_address),''),
      lat=p_lat,
      lng=p_lng,
      guide_data=coalesce(p_guide_data,'{}'::jsonb),
      geocoding_data=case
        when public.spots.address is distinct from nullif(trim(p_address),'')
          or public.spots.lat is distinct from p_lat
          or public.spots.lng is distinct from p_lng
        then null
        else public.spots.geocoding_data
      end,
      updated_at=now()
  where id=p_spot_id;
  insert into public.spot_operation_logs(region_id,spot_id,spot_name,operation_type,actor_user_id,details)
  values(v_region,p_spot_id,trim(p_name),'update',auth.uid(),jsonb_build_object('previous_name',v_old_name));
end;
$function$;
