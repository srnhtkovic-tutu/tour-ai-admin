-- Human review workflow for AI-merged tourism spot candidates.
-- Reuses spot_import_merged_v2; no separate review table is created.

alter table public.spot_import_merged_v2
  add column if not exists review_status text not null default 'pending',
  add column if not exists reviewed_data jsonb,
  add column if not exists reviewed_by uuid references auth.users(id) on delete set null,
  add column if not exists reviewed_at timestamptz,
  add column if not exists approved_spot_id bigint,
  add column if not exists region_id uuid references public.regions(id) on delete set null;

update public.spot_import_merged_v2 m
set region_id=j.region_id
from public.spot_import_jobs j
where j.id=m.job_id and m.region_id is distinct from j.region_id;

create or replace function private.set_merged_candidate_region()
returns trigger language plpgsql security definer set search_path=''
as $
begin
  select j.region_id into new.region_id from public.spot_import_jobs j where j.id=new.job_id;
  return new;
end;
$;
revoke all on function private.set_merged_candidate_region() from public,anon,authenticated;
drop trigger if exists set_merged_candidate_region on public.spot_import_merged_v2;
create trigger set_merged_candidate_region before insert or update of job_id on public.spot_import_merged_v2 for each row execute function private.set_merged_candidate_region();

alter table public.spot_import_merged_v2
  drop constraint if exists spot_import_merged_v2_review_status_check;
alter table public.spot_import_merged_v2
  add constraint spot_import_merged_v2_review_status_check
  check (review_status in ('pending','approved','rejected'));

drop policy if exists merged_v2_select_region_review on public.spot_import_merged_v2;
create policy merged_v2_select_region_review
on public.spot_import_merged_v2 for select to authenticated
using (private.is_system_admin() or private.has_region_access(region_id));
grant select on public.spot_import_merged_v2 to authenticated;

create or replace function public.save_spot_import_review(p_candidate_id uuid,p_reviewed_data jsonb)
returns void language plpgsql security definer set search_path=''
as $$
declare v_region uuid; v_status text; v_decision text;
begin
  if auth.uid() is null then raise exception 'ログインが必要です'; end if;
  if p_reviewed_data is null or jsonb_typeof(p_reviewed_data)<>'object' then raise exception '審査内容の形式が正しくありません'; end if;
  select j.region_id,m.status,m.merged_data->>'decision' into v_region,v_status,v_decision from public.spot_import_merged_v2 m join public.spot_import_jobs j on j.id=m.job_id where m.id=p_candidate_id;
  if not found then raise exception '審査候補が見つかりません'; end if;
  if v_status<>'completed' or v_decision<>'accepted' then raise exception 'この候補は審査対象ではありません'; end if;
  if not (private.is_system_admin() or private.has_region_access(v_region)) then raise exception 'この地域の審査権限がありません'; end if;
  if length(coalesce(p_reviewed_data->>'name','')) not between 1 and 100 then raise exception 'スポット名は1〜100文字で入力してください'; end if;
  if length(coalesce(p_reviewed_data->>'address',''))>200 then raise exception '住所は200文字以内で入力してください'; end if;
  if coalesce(length(p_reviewed_data->'guide_data'->>'officialUrl'),0)>2000 then raise exception '公式サイトURLは2000文字以内で入力してください'; end if;
  if jsonb_typeof(coalesce(p_reviewed_data->'guide_data','{}'::jsonb))<>'object' then raise exception '紹介情報の形式が正しくありません'; end if;
  if exists(select 1 from jsonb_each_text(coalesce(p_reviewed_data->'guide_data','{}'::jsonb)) e where e.key in ('catchCopy','topReason','bestSeason','latestTopics','recommendFood','recommendHistory','recommendRelax','recommendActivity','localRecommendation') and length(e.value)>2000) then raise exception '紹介文は各項目2000文字以内で入力してください'; end if;
  update public.spot_import_merged_v2 set reviewed_data=p_reviewed_data,reviewed_by=auth.uid(),reviewed_at=now(),updated_at=now()
  where id=p_candidate_id and review_status='pending';
  if not found then raise exception 'この候補は別の担当者によって処理済みです。画面を更新してください'; end if;
end;
$$;

create or replace function public.reject_spot_import_review(p_candidate_id uuid)
returns void language plpgsql security definer set search_path=''
as $$
declare v_region uuid; v_status text; v_decision text;
begin
  if auth.uid() is null then raise exception 'ログインが必要です'; end if;
  select j.region_id,m.status,m.merged_data->>'decision' into v_region,v_status,v_decision from public.spot_import_merged_v2 m join public.spot_import_jobs j on j.id=m.job_id where m.id=p_candidate_id;
  if not found then raise exception '審査候補が見つかりません'; end if;
  if v_status<>'completed' or v_decision<>'accepted' then raise exception 'この候補は審査対象ではありません'; end if;
  if not (private.is_system_admin() or private.has_region_access(v_region)) then raise exception 'この地域の審査権限がありません'; end if;
  update public.spot_import_merged_v2 set review_status='rejected',reviewed_by=auth.uid(),reviewed_at=now(),updated_at=now()
  where id=p_candidate_id and review_status='pending';
  if not found then raise exception 'この候補は別の担当者によって処理済みです。画面を更新してください'; end if;
end;
$$;

create or replace function public.approve_spot_import_review(p_candidate_id uuid)
returns bigint language plpgsql security definer set search_path=''
as $$
declare v_candidate public.spot_import_merged_v2%rowtype; v_region uuid; v_data jsonb; v_guide jsonb; v_name text; v_spot_id bigint; v_lat double precision; v_lng double precision;
begin
  if auth.uid() is null then raise exception 'ログインが必要です'; end if;
  select * into v_candidate from public.spot_import_merged_v2 where id=p_candidate_id for update;
  if not found then raise exception '審査候補が見つかりません'; end if;
  if v_candidate.status<>'completed' or v_candidate.merged_data->>'decision'<>'accepted' then raise exception 'この候補は審査対象ではありません'; end if;
  if v_candidate.review_status<>'pending' then raise exception 'この候補は別の担当者によって処理済みです。画面を更新してください'; end if;
  select region_id into v_region from public.spot_import_jobs where id=v_candidate.job_id;
  if not found then raise exception '元の収集ジョブが見つかりません'; end if;
  if not (private.is_system_admin() or private.has_region_access(v_region)) then raise exception 'この地域の承認権限がありません'; end if;
  if not exists(select 1 from public.regions where id=v_region and is_active) then raise exception '無効な地域の候補は承認できません'; end if;
  v_data:=coalesce(v_candidate.reviewed_data,v_candidate.merged_data);
  if v_data is null then raise exception '審査データがありません'; end if;
  v_name:=trim(coalesce(v_data->>'name',v_candidate.spot_name)); v_guide:=coalesce(v_data->'guide_data','{}'::jsonb);
  if v_name='' or length(v_name)>100 then raise exception 'スポット名は1〜100文字で入力してください'; end if;
  if length(coalesce(v_data->>'address',''))>200 then raise exception '住所は200文字以内で入力してください'; end if;
  if jsonb_typeof(v_guide)<>'object' then raise exception '紹介情報の形式が正しくありません'; end if;
  if coalesce(length(v_guide->>'officialUrl'),0)>2000 then raise exception '公式サイトURLは2000文字以内で入力してください'; end if;
  if exists(select 1 from jsonb_each_text(v_guide) e where e.key in ('catchCopy','topReason','bestSeason','latestTopics','recommendFood','recommendHistory','recommendRelax','recommendActivity','localRecommendation') and length(e.value)>2000) then raise exception '紹介文は各項目2000文字以内で入力してください'; end if;
  v_lat:=nullif(v_data->>'lat','')::double precision; v_lng:=nullif(v_data->>'lng','')::double precision;
  if (v_lat is null)<>(v_lng is null) then raise exception '緯度と経度は両方入力してください'; end if;
  if v_lat is not null and (v_lat < -90 or v_lat>90 or v_lng < -180 or v_lng>180) then raise exception '緯度・経度の範囲が正しくありません'; end if;
  insert into public.spots(name,address,lat,lng,guide_data,region_id) values(v_name,nullif(trim(v_data->>'address'),''),v_lat,v_lng,v_guide,v_region) returning id into v_spot_id;
  insert into public.spot_operation_logs(region_id,spot_id,spot_name,operation_type,actor_user_id,details)
  values(v_region,v_spot_id,v_name,'approve',auth.uid(),jsonb_build_object('source','ai_review','candidate_id',p_candidate_id));
  update public.spot_import_merged_v2 set review_status='approved',reviewed_by=auth.uid(),reviewed_at=now(),approved_spot_id=v_spot_id,updated_at=now() where id=p_candidate_id;
  return v_spot_id;
end;
$$;

revoke all on function public.save_spot_import_review(uuid,jsonb) from public,anon;
revoke all on function public.reject_spot_import_review(uuid) from public,anon;
revoke all on function public.approve_spot_import_review(uuid) from public,anon;
grant execute on function public.save_spot_import_review(uuid,jsonb) to authenticated;
grant execute on function public.reject_spot_import_review(uuid) to authenticated;
grant execute on function public.approve_spot_import_review(uuid) to authenticated;
