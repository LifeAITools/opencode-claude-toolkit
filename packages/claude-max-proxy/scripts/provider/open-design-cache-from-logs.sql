-- Срок жизни кэша OpenDesign ПО ЛОГАМ ФЛОТА — тот же метод, что мерили для OpenCode Go.
--
-- Читает LiteLLM_SpendLogs (локальный посредник, контейнер kiberos-litellm-db).
-- Для каждого вызова считает ПАУЗУ с предыдущим вызовом ТОЙ ЖЕ сессии и долю
-- cached_tokens. Группирует по паузам: пока доля держится — кэш жив; упала — срок вышел.
--
-- 🔴 ГРАНИЦЫ МЕТОДА (иначе получится вывод не про то):
--  • только prompt_tokens > 20000: на маленьком префиксе кэш может не включиться, и
--    «0 из кэша» прочитается как «кэш умер»;
--  • `cache_hit` НЕ ИСПОЛЬЗУЕМ — эта колонка про кэш самого LiteLLM и на замерах 05.11
--    показывала False при 99% попаданий; число берём из usage_object;
--  • NULL (поставщик не сообщил) — это «не измерено», а не ноль: такие строки не должны
--    попадать в среднее как 0. Здесь они дают c=0 только если поля правда нет; для строгого
--    счёта фильтруйте строки, где cached_tokens IS NULL.
--
-- Запуск:
--   docker exec -i kiberos-litellm-db psql -U litellm -d litellm < this-file.sql
with x as (
  select session_id,
         "startTime" as t,
         prompt_tokens as p,
         (metadata::json->'usage_object'->'prompt_tokens_details'->>'cached_tokens') as cached_raw,
         coalesce(((metadata::json->'usage_object'->'prompt_tokens_details'->>'cached_tokens')::int), 0) as c,
         lag("startTime") over (partition by session_id order by "startTime") as prev
  from "LiteLLM_SpendLogs"
  where model_group = 'deepseek-v4.1-flash-od'
    and prompt_tokens > 20000
    and "startTime" > now() - interval '7 days'
)
select case
         when prev is null then 'первый в сессии'
         when extract(epoch from (t - prev)) / 60 < 5  then '<5м'
         when extract(epoch from (t - prev)) / 60 < 15 then '5-15м'
         when extract(epoch from (t - prev)) / 60 < 30 then '15-30м'
         when extract(epoch from (t - prev)) / 60 < 45 then '30-45м'
         when extract(epoch from (t - prev)) / 60 < 60 then '45-60м'
         when extract(epoch from (t - prev)) / 60 < 90 then '60-90м'
         when extract(epoch from (t - prev)) / 60 < 120 then '90-120м'
         else '>120м' end as bucket,
       count(*) as calls,
       count(*) filter (where cached_raw is null) as unmeasured,
       round(avg(c::numeric / p), 3) as cached_share,
       round(avg((c::numeric / p) >= 0.9)::numeric, 3) as share_full_hits,
       round(min(c::numeric / p), 3) as mn,
       round(max(c::numeric / p), 3) as mx
from x
group by 1
order by min(case
         when prev is null then -1
         else extract(epoch from (t - prev)) / 60 end);
