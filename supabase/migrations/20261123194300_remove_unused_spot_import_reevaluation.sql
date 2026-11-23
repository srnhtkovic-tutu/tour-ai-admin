drop function if exists public.worker_save_spot_import_reevaluation_progress(
  uuid,uuid,uuid,text,text,jsonb,jsonb,text,jsonb,text,text
);
drop function if exists private.save_spot_import_reevaluation_progress_v1(
  uuid,uuid,uuid,text,text,jsonb,jsonb,text,jsonb,text,text
);
alter table public.spot_import_merged_v2
  drop constraint if exists spot_import_merged_v2_reevaluation_status_check;
alter table public.spot_import_merged_v2
  drop column if exists reevaluation_status,
  drop column if exists reevaluation_progress,
  drop column if exists reevaluation_results,
  drop column if exists reevaluation_relevance_model,
  drop column if exists reevaluation_merged_data,
  drop column if exists reevaluation_model,
  drop column if exists reevaluation_error_message;
