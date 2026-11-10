alter table public.spots add column if not exists address text;
alter table public.spots add column if not exists updated_at timestamptz not null default now();

create or replace function public.create_region_spot(
  p_region_id uuid, p_name text, p_address text, p_lat double precision,
  p_lng double precision, p_guide_data jsonb
) returns bigint
language plpgsql security definer set search_path = ''
as $$
declare v_id bigint;
begin
  if auth.uid() is null then raise exception 'ログインが必要です'; end if;
  if not (private.is_system_admin() or private.has_region_access(p_region_id)) then
    raise exception 'この地域へのアクセス権限がありません';
  end if;
  if not exists(select 1 from public.regions r where r.id=p_region_id and r.is_active) then
    raise exception '無効な地域にはスポットを登録できません';
  end if;
  if p_name is null or length(trim(p_name))=0 or length(p_name)>100 then raise exception 'スポット名は1〜100文字で入力してください'; end if;
  if p_address is not null and length(p_address)>200 then raise exception '住所は200文字以内で入力してください'; end if;
  if p_guide_data is not null and jsonb_typeof(p_guide_data)<>'object' then raise exception '紹介情報の形式が正しくありません'; end if;
  if coalesce(length(p_guide_data->>'officialUrl'),0)>2000 then raise exception '公式サイトURLは2000文字以内で入力してください'; end if;
  if exists(select 1 from jsonb_each_text(coalesce(p_guide_data,'{}'::jsonb)) e where e.key in ('catchCopy','topReason','bestSeason','latestTopics','recommendFood','recommendHistory','recommendRelax','recommendActivity','localRecommendation') and length(e.value)>2000) then
    raise exception '紹介文は各項目2000文字以内で入力してください';
  end if;
  insert into public.spots(name,address,lat,lng,guide_data,region_id)
  values(trim(p_name),nullif(trim(p_address),''),p_lat,p_lng,coalesce(p_guide_data,'{}'::jsonb),p_region_id)
  returning id into v_id;
  insert into public.spot_operation_logs(region_id,spot_id,spot_name,operation_type,actor_user_id,details)
  values(p_region_id,v_id,trim(p_name),'register',auth.uid(),jsonb_build_object('source','manual'));
  return v_id;
end;
$$;

create or replace function public.update_region_spot(
  p_spot_id bigint, p_name text, p_address text, p_lat double precision,
  p_lng double precision, p_guide_data jsonb
) returns void
language plpgsql security definer set search_path = ''
as $$
declare v_region uuid; v_old_name text;
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
  update public.spots set name=trim(p_name),address=nullif(trim(p_address),''),lat=p_lat,lng=p_lng,guide_data=coalesce(p_guide_data,'{}'::jsonb),updated_at=now() where id=p_spot_id;
  insert into public.spot_operation_logs(region_id,spot_id,spot_name,operation_type,actor_user_id,details)
  values(v_region,p_spot_id,trim(p_name),'update',auth.uid(),jsonb_build_object('previous_name',v_old_name));
end;
$$;

create or replace function public.delete_region_spot(p_spot_id bigint)
returns void language plpgsql security definer set search_path = ''
as $$
declare v_region uuid; v_name text;
begin
  if auth.uid() is null then raise exception 'ログインが必要です'; end if;
  select region_id,name into v_region,v_name from public.spots where id=p_spot_id;
  if not found then raise exception '対象スポットが見つかりません'; end if;
  if not (private.is_system_admin() or private.has_region_access(v_region)) then raise exception 'このスポットを削除する権限がありません'; end if;
  delete from public.spots where id=p_spot_id;
  insert into public.spot_operation_logs(region_id,spot_id,spot_name,operation_type,actor_user_id,details)
  values(v_region,p_spot_id,v_name,'delete',auth.uid(),'{}'::jsonb);
end;
$$;

revoke all on function public.create_region_spot(uuid,text,text,double precision,double precision,jsonb) from public, anon;
revoke all on function public.update_region_spot(bigint,text,text,double precision,double precision,jsonb) from public, anon;
revoke all on function public.delete_region_spot(bigint) from public, anon;
grant execute on function public.create_region_spot(uuid,text,text,double precision,double precision,jsonb) to authenticated;
grant execute on function public.update_region_spot(bigint,text,text,double precision,double precision,jsonb) to authenticated;
grant execute on function public.delete_region_spot(bigint) to authenticated;
