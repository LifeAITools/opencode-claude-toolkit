# Changelog

All notable changes to `@life-ai-tools/claude-code-sdk` and the `opencode-claude` plugin.

## [Unreleased] - 2026-11-08

### Изменено
- **S7 закрыт: прогрев Go не вводится.** Решение 08.11.2026 (`home-relishev-general`). Основание: у Go бесплатного прогрева не существует — первое обращение это платная холодная запись префикса, а директива фаундера 11.09 запрещает прогреву тратить квоту на запись; плюс предстоящий переезд на DeepSeek Harness. Кода прогрева Go нет и не будет в текущей ветке: флага `warmQuotaShareMax` не существует. Подробности — комментарий в `packages/claude-max-proxy/src/modules/go-door.ts`.

## [Proxy 1.0.35 → 1.3.0] - 2026-08-19 … 2026-11-05 (восстановлено задним числом)

> 🔁 **ЭТИ ЗАПИСИ ВОССТАНОВЛЕНЫ 2026-11-08 ПО GIT-ИСТОРИИ** и не писались в момент выпуска.
> Каждая строка — коммит, которым версия попала в `packages/claude-max-proxy/package.json`;
> текст — смысл сообщения коммита, без пересказа диффов. Номеров, которых нет в истории файла,
> в таблице нет: пропуски не заполнялись догадкой. Версии SDK/плагина (0.20.x) и адаптера
> `opencode-signal-wire` (0.5.x) живут в истории своих пакетов — здесь только прокси.

### 2026-08

| Версия | Дата | Что изменилось |
|---|---|---|
| 1.0.35 | 2026-08-19 | предохранитель разоружал весь флот, а вернуться было нечем — теперь ждёт |
| 1.0.36 | 2026-08-19 | о процессе прогрева журнал знал только pid — посмертно это не имя |
| 1.0.37 | 2026-08-20 | оплаченный кэш главного агента больше не выбрасывают сразу после покупки |
| 1.0.38 | 2026-08-20 | строка в keep-warm приписывала себе смысл, которого не несла |
| 1.0.39 | 2026-08-20 | своя же новая строка журнала обрезала опознаватель ровно там, где он неоднозначен |
| 1.0.40 | 2026-08-20 | два отказа в пути тёплого кэша выглядели ровно как исправная тишина |
| 1.0.41 | 2026-08-20 | тревога о незаписанном файле снимков проверена сквозь службу, а не только у функции |
| 1.0.42 | 2026-08-20 | «версия Claude Code сменилась» было фактом об общем поле, а не о сессии |
| 1.0.43 | 2026-08-20 | воскрешённая линия не могла предупредить флот, сколько бы раз она это ни доказала |
| 1.0.44 | 2026-08-20 | закрепление срока не может обещать жизнь дольше, чем показывает провод |
| 1.0.45 | 2026-08-20 | флот ждал из-за одной потери кэша — а замер говорит, что покупка окупается всегда |
| 1.0.46 | 2026-08-20 | 57% трат прогрева на запись кэша проходили мимо прибора |
| 1.0.47 | 2026-08-20 | выстрел прогрева не называл аккаунт — и версию про перезапуск нечем было проверить |
| 1.0.48 | 2026-08-20 | воскрешённая сессия грелась на ЧУЖОМ аккаунте — и покупала весь префикс заново |
| 1.0.49 | 2026-08-20 | если аккаунт сессии при подъёме недоступен — не греть на чужом, а не греть вовсе |
| 1.0.50 | 2026-08-20 | в реестре снимков лежал живой токен, и файл читала вся машина |
| 1.0.51 | 2026-08-20 | права на файл снимков ставились только при создании — живой файл остался открытым |
| 1.0.52 | 2026-08-21 | отказ по смене аккаунта теперь называет бесплатный выход, а не только цену |
| 1.0.53 | 2026-08-28 | сессия, остановленная сторожем кэша, зовёт человека — сама она не может |
| 1.0.54 | 2026-08-28 | опубликован в npm.muid.io вместе с SDK 0.20.58 |
| 1.0.56 | 2026-08-28 | установка по публичной ссылке не работала ни у кого извне — три поломки подряд |
| 1.0.59 | 2026-08-28 | пакет стало возможно ПРИНЯТЬ — машинная проверка, честный README, и он больше не везёт наши внутренности |
| 1.0.60 | 2026-08-28 | выброшен jimp — библиотека обработки изображений, которую никто не звал |
| 1.0.61 | 2026-08-29 | строка здоровья несёт память — иначе смерть по памяти нечем объяснить |
| 1.0.62 | 2026-08-29 | граница между открытым и закрытым проведена по смыслу — четыре шага одним заходом |
| 1.0.63 | 2026-08-29 | двухмегабайтное тело больше не разбирается ради проверки, которой почти никогда нечего делать |
| 1.0.64 | 2026-08-29 | снимок прогрева хранится строкой — неизменяемость по устройству вместо копирования |
| 1.0.65 | 2026-08-29 | прокси, который работает и не греет ничего, теперь говорит это вслух |
| 1.0.66 | 2026-08-29 | ноль сессий больше не значит две разные вещи сразу |
| 1.0.67 | 2026-08-29 | чужое имя сессии больше не уводит дамп из своего каталога |
| 1.0.68 | 2026-08-29 | подсказка сторожа зовёт ту форму согласия, что переживёт набор команды |
| 1.0.71 | 2026-08-29 | тревога о безымянном запросе называет звонящего, а не нашу подстановку |
| 1.0.72 | 2026-08-29 | SDK 0.20.62 + прокси 1.0.72 — сегодняшние починки доехали до реестра |
| 1.0.75 | 2026-08-29 | порог прогрева был выведен из цен API, которых у нас нет |
| 1.0.76 | 2026-08-29 | служебный удар прогрева наконец приносит показание счётчика подписки |

### 2026-09

| Версия | Дата | Что изменилось |
|---|---|---|
| 1.0.77 | 2026-09-02 | отказ сторожа называет субагента и того, кто даёт за него согласие |
| 1.0.78 | 2026-09-02 | отказ говорит, что номер в команде — субагента, а не родителя |
| 1.0.79 | 2026-09-02 | имя субагента стоит на каждом ходу, а не только на отказе |
| 1.0.80 | 2026-09-02 | отказ по квоте называет аккаунт и его долю, а не одну лишь сессию |
| 1.0.81 | 2026-09-02 | дверь /stats сама говорит, когда отвечает медленно |
| 1.0.82 | 2026-09-02 | отсутствие входа — первый шаг человека, а не красный крестик |
| 1.0.83 | 2026-09-03 | файл квоты называет аккаунт почтой, а не одним номером |
| 1.0.84 | 2026-09-03 | почта аккаунта едет под тем именем, которое читают потребители |
| 1.0.85 | 2026-09-03 | остывший кэш не «выбрасывается этим ходом» — он умер по часам раньше |
| 1.0.86 | 2026-09-03 | решение бросить кэш едет с числами, на которых оно принято |
| 1.0.87 | 2026-09-03 | сторож запаса — настоящие ходы стоят, прогрев идёт, кэши живут |
| 1.0.88 | 2026-09-03 | перезапись прогревом видна в журнале — трата, идущая мимо сторожа |
| 1.0.89 | 2026-09-03 | привязка сессии к аккаунту переживает перезапуск и сон агента |
| 1.0.90 | 2026-09-03 | цена перезаписи считается по расхождению, а не по весу разговора |
| 1.0.91 | 2026-09-03 | стоящий агент зовёт человека, пока стоит, а не один раз в первые 15 минут |
| 1.0.92 | 2026-09-04 | роль родословной едет на событиях прогрева — чьи кэши перекупаются |
| 1.0.93 | 2026-09-04 | промежуток служебных запросов — доля срока кэша, а не вбитые минуты |
| 1.0.94 | 2026-09-04 | сессия без опознанного владельца называет своего клиента |
| 1.0.95 | 2026-09-04 | паспорт владельца сессии — что за процесс, откуда и кто его запустил |
| 1.0.96 | 2026-09-04 | паспорт владельца снимается там, где сессия РОЖДАЕТСЯ на самом деле |
| 1.0.97 | 2026-09-04 | прогрев, который не вооружился, называет причину |
| 1.0.98 | 2026-09-05 | обращения к поиску в интернете попадают в учёт |
| 1.0.99 | 2026-09-05 | во время перезапуска дверь ОТВЕЧАЕТ, а не молчит |
| 1.1.0 | 2026-09-05 | серверный инструмент Anthropic проходит дверь, а не роняет её |
| 1.1.1 | 2026-09-05 | способ, доступный человеку, стоит в первых 512 знаках отказа |
| 1.1.2 | 2026-09-11 | обход стоящих сам судит о жизни, а не ждёт события от забытой памяти |
| 1.1.3 | 2026-09-11 | у стоящей сессии записывается каталог владельца — «сессия abc» без проекта человеку ничего не говорит |
| 1.1.4 | 2026-09-11 | дверь /admin/cache-rewrite-ok — исполнителю нажатия больше не нужен чужой CLI |
| 1.1.5 | 2026-09-11 | путь к учёту стоящих приходит аргументом — испытания писали в ЖИВОЙ файл машины |
| 1.1.6 | 2026-09-11 | сторож против того, чтобы испытания правили боевой учёт стоящих |
| 1.1.7 | 2026-09-11 | у каждого снимка свои часы — прогрев платил за мёртвые ветки 3.3 млн токенов за утро |
| 1.1.8 | 2026-09-11 | дверь снятия стоящей сессии — мёртвую запись нечем было убрать, кроме правки боевого файла руками |
| 1.1.9 | 2026-09-15 | стоящая сессия зовёт человека туда, где он читает — журнала и всплывашки не хватало |
| 1.1.10 | 2026-09-15 | дверь /llms.txt — служба сама говорит, что она и что значит её отказ |
| 1.1.11 | 2026-09-15 | различитель «чей обрезок» — битые доводы орудия называются с номером письма |
| 1.1.12 | 2026-09-15 | номер письма (msg_...) на КАЖДОМ завершённом ходе, а не только при поломке |
| 1.1.13 | 2026-09-15 | непотоковый ответ тоже называет своё письмо |
| 1.1.14 | 2026-09-19 | справка о стоящей сессии — спросить «стоит ли» больше не значит «разреши» |
| 1.1.15 | 2026-09-19 | прогон испытаний больше не будит живого человека — замок в самой двери и НЕСНИМАЕМ |
| 1.1.16 | 2026-09-19 | prompt_tokens — ВЕСЬ вход, и запись кэша наконец доезжает |
| 1.1.17 | 2026-09-23 | Opus 5.5 и Fable 5.1 в реестре + починка размышления по модели |
| 1.1.18 | 2026-09-23 | чужие клиенты представляются версией установленного Claude Code, а не литералом |
| 1.1.19 | 2026-09-23 | пол версии для сайдкаров — 2.1.280 (минимум для opus-5-5) |
| 1.1.20 | 2026-09-23 | на двери OpenAI несёт retry-after апстрима |
| 1.1.21 | 2026-09-24 | заблаговременное продление ключа больше не сжимается до последних минут |
| 1.1.22 | 2026-09-26 | карточка о стоящей сессии несёт клеймо запуска — агента называют по личности, а не по папке |
| 1.1.23 | 2026-09-26 | после сброса окна старое показание больше не держит ходы |
| 1.1.24 | 2026-09-27 | claude-max больше не читает .env папки проекта |
| 1.1.25 | 2026-09-27 | помощник у сторожа кэша больше не зовёт человека карточкой |
| 1.1.26 | 2026-09-27 | помощники больше не вытесняются из прогрева прежними головами разговора |
| 1.1.27 | 2026-09-30 | мёртвая ветка больше не уносит из прогрева живые, которым просто ещё рано |
| 1.1.28 | 2026-09-30 | стена запаса встаёт по времени до сброса — там, где остатка хватает прогреву, а не на одном 0.95 |
| 1.1.29 | 2026-09-30 | состояние сторожа называет основание линии и расход прогрева до сброса |
| 1.1.30 | 2026-09-30 | после перезапуска прокси мёртвые ветки остаются мёртвыми — снимок на диске несёт свои часы ветки |
| 1.1.31 | 2026-09-30 | у каждой ветки свой срок жизни кэша из её меток — и момент выстрела считается от него |
| 1.1.32 | 2026-09-30 | строка фаундеру в комнату проекта, когда прогрев купил кэш |
| 1.1.33 | 2026-09-30 | выстрел прогрева без ответа — неудача, а не прогрев |
| 1.1.34 | 2026-09-30 | ответ без чисел на выстрел прогрева — ошибка, а не завершение с нулями |

### 2026-10

| Версия | Дата | Что изменилось |
|---|---|---|
| 1.1.35 | 2026-10-01 | Sonnet 5.5 в реестре — своя цена и запрет выключать размышления |
| 1.1.37 | 2026-10-01 | испытания больше не пишут в боевой журнал и не подменяют настройку прогрева |
| 1.1.39 | 2026-10-01 | системная часть строкой больше не теряется; заголовок отказа от точек кэша |
| 1.1.40 | 2026-10-02 | сборщик квоты Alibaba Token Plan — файл для подвала агентов OpenCode, эпизоды истёкшего входа |
| 1.1.41 | 2026-10-06 | (картинки + mime) |
| 1.1.42 | 2026-10-06 | (самописец spark) |
| 1.1.43 | 2026-10-06 | (cached_tokens) |
| 1.1.44 | 2026-10-07 | (роут spark с /v1/messages) |
| 1.1.45 | 2026-10-07 | (deepseek-v4.1-flash) |
| 1.1.46 | 2026-10-09 | сборщик Go не удваивает проценты |
| 1.1.47 | 2026-10-09 | кэш-лес сессии не пинятся + follow-session |
| 1.1.48 | 2026-10-14 | streaming usage carries cache_read_input_tokens + input_tokens |
| 1.1.49 | 2026-10-15 | Go door /go/* with org registry, single credential issuer, provider-dump/v1 |
| 1.1.50 | 2026-10-15 | /go missing or broken registry is 503 (server), not 400 (request) |
| 1.1.51 | 2026-10-16 | stuck ledger retires on session.end + worktree-to-root successor match |
| 1.1.52 | 2026-10-17 | complete org picture — all vault orgs with windows + status (S1/D1) |
| 1.1.53 | 2026-10-17 | one session-identity rule for every provider door (S3/FR-19/D3) |
| 1.1.55 | 2026-10-17 | org picture carries windows across a watcher restart |
| 1.1.56 | 2026-10-17 | Go org report carries status + restrictedReason + models per org (S2/FR-1/FR-18) |
| 1.1.57 | 2026-10-17 | provider-dump/v1 schema as a versioned contract in code + validator (S4/FR-21/D6) |
| 1.1.58 | 2026-10-17 | human modes auto / away-until / off per session (S8/FR-7) |
| 1.1.59 | 2026-10-17 | quota-status.json names the traffic silence instead of an empty accounts |
| 1.1.60 | 2026-10-17 | door readiness without a probe — an unconfigured /go door is named at boot and visible in /health (S5/D5) |
| 1.1.61 | 2026-10-17 | a Go door that passes nothing is named aloud — window in /health, one alert per storm (S5/D5) |
| 1.1.62 | 2026-10-17 | door-watch counts the SUCCESS share per door — an Anthropic door passing nothing is named too, with the cause (S5/D5) |
| 1.1.63 | 2026-10-19 | образ /spark-шва (реестр вместо застывших SPARK_*) |
| 1.1.64 | 2026-10-19 | имя сессии зовущего — читать ИЗМЕРЕННЫЕ имена, а не выдуманное |
| 1.1.65 | 2026-10-21 | проход по ВСЕМ организациям Go по расписанию |
| 1.1.67 | 2026-10-22 | выбор организации Go по ЗАПАСУ, а не по `active:` реестра |
| 1.1.68 | 2026-10-22 | отчёт квоты читается рядом с реестром, а не из ~/.claude-local |
| 1.1.69 | 2026-10-23 | организация без пропуска названа в отчёте, а не молчит |
| 1.1.70 | 2026-10-23 | дверь Go читает отчёт квоты и дома, а не только рядом с хранилищем |
| 1.1.71 | 2026-10-23 | отвергнутый пропуск — тоже названный факт, а не «окон нет» |
| 1.1.72 | 2026-10-23 | дверь видит новые входы, пока их никто не слил |
| 1.1.73 | 2026-10-23 | дверь /spark называет кэш всегда — ноль это измерение, а не тишина |
| 1.1.74 | 2026-10-23 | дверь Go называет переписанную историю — прибор против «движков, ломающих кэш» |
| 1.1.75 | 2026-10-23 | дверь Go называет МЕСТО расхождения — не только факт переписи |
| 1.1.76 | 2026-10-23 | сторож переписи на двери Go — остановить перепись при ЖИВОМ кэше и назвать место |
| 1.1.77 | 2026-10-23 | активная организация выводится из сверки с account_state, а не копируется из реестра |
| 1.1.78 | 2026-10-23 | снимок места переписи — «с чего на что», а не только «сообщение #N изменилось» |
| 1.1.79 | 2026-10-23 | сверка активной пары по ИДЕНТИФИКАТОРАМ, имена — только ярлыки |
| 1.1.80 | 2026-10-24 | производитель не переносит число ЗАКРЫТОГО окна под свежий штамп |
| 1.1.81 | 2026-10-24 | журнал ПЕРЕХОДОВ окна — «сбросилось» становится фактом, а не догадкой |
| 1.1.82 | 2026-10-26 | выбор организации Go липок к сессии |
| 1.1.83 | 2026-10-26 | якорь липкости из тела разговора, когда номер сессии не пришёл |
| 1.1.84 | 2026-10-26 | организация выдаётся один раз и переиспользуется |
| 1.1.85 | 2026-10-26 | дверь называет обслуженную организацию в заголовке ответа |
| 1.1.86 | 2026-10-26 | скрипты продления Go переехали сюда; дверь пишет спул тела |
| 1.1.87 | 2026-10-26 | дверь называет ИСТОЧНИК организации (named/pin/quota/active) |
| 1.1.88 | 2026-10-26 | выбор организации по времени до стены (модель фаундера 26.10) |
| 1.1.89 | 2026-10-26 | выдачи организации переживают перезапуск двери |
| 1.1.90 | 2026-10-27 | GET /admin/served-org — кто реально обслужил сессию |
| 1.1.91 | 2026-10-28 | дописывание любой длины больше не считается переписью |
| 1.1.92 | 2026-10-29 | полоса префикса = сессия + system, служебные вызовы больше не затирают слепок |
| 1.1.93 | 2026-10-30 | исключение сторожа по зовущему — пустой список, готовый к слову фаундера |
| 1.1.94 | 2026-10-30 | запись в кэш и «кто звал» — два поля, которые я зря считал недоступными |
| 1.1.95 | 2026-10-30 | исключение сторожа — по ЯВНОЙ МЕТКЕ зовущего, а не по UA и не по «нет сессии» |
| 1.1.96 | 2026-10-30 | переселение сессии между организациями больше не немое — причина названа |
| 1.1.97 | 2026-10-30 | истёкшая выдача — тоже переезд, и теперь она в счётчике |
| 1.2.1 | 2026-10-30 | названная организация за стеной и без сессии — берём годную |
| 1.2.2 | 2026-10-30 | запись в кэш больше не пропадает из-за нуля в явном поле |
| 1.2.4 | 2026-10-30 | переезд — в структуре записи, и цикл «429 → свежая организация» назван |

### 2026-11

| Версия | Дата | Что изменилось |
|---|---|---|
| 1.2.5 | 2026-11-01 | журнал денег на проде |
| 1.2.6 | 2026-11-02 | фикс оспаривания исчерпанной названной организации |
| 1.2.7 | 2026-11-02 | выдача снимается на 429 при любом источнике — иначе named-сессия упиралась в стену вечно |
| 1.2.8 | 2026-11-02 | дверь объявляет цену вызова (usage.cost=list_cost) — spend и лимиты ступеней оживают |
| 1.2.9 | 2026-11-03 | оборванный клиентом поток даёт исход GO_ABORTED — requests сходится с исходами |
| 1.3.0 | 2026-11-05 | дверь OpenDesign, анализатор размещения, ряд замеров |

## [0.20.36] - 2026-08-18 (proxy 1.0.23)

### Fixed
- **Запрос без опознавателя больше не заводит вечную keepalive-родословную.**
  Вызов без заголовка `x-claude-code-session-id` получал синтетический ключ
  `anon-<timestamp>`, уникальный для одного этого запроса, — и под ним
  открывалась полноценная KA-родословная, которую двигатель грел, пока жив
  процесс-владелец. Совпасть с этим ключом не мог никто: замер живого прокси
  2026-08-18 (`research/cache-accounting-remeasure-2026-08-18.md`) — 463 из 521
  сохранённого префикса такие, и у каждого ровно одна запись. 428 из них
  грелись медиану 8.7 ч (максимум 24.8 ч) после единственного запроса, а в окне
  29 минут 70 из 89 выстрелов KA (79 %) и 6 592 380 cache-read токенов (36 %)
  ушли на сессии, которые не могли вернуться. Теперь такой запрос обслуживается,
  но не вооружается: `notifyRealRequestStart` не вызывается, поэтому нечего
  фиксировать в реестр и тику нечего греть.
- **Оживлён `extractSessionIdFromBody`** — второй способ узнать сессию, по
  `metadata.user_id`. Он был написан, покрыт тестами и экспортирован, но
  вызывающего не имел: правка жила только в задеплоенной копии
  (`HANDOVER-quota-pipeline.md`: «the import there is live-only») и была стёрта
  первым же manifest-деплоем. Агент, спавненный через Agent SDK, снова узнаётся
  по телу запроса.
- **Тесты перестали читать живое состояние флота.** `ProxyClient` без явного
  `kaSnapshotPath` открывал 70-МБ файл снимков живого демона, оживлял из него
  все сессии внутри тест-процесса и записывал файл обратно на `stop()`.
  `DEFAULT_KA_SNAPSHOT_PATH` теперь уважает `CLAUDE_KA_SNAPSHOT_PATH`, и
  preload тестов его задаёт.

### Added
- `HandleRequestContext.idSource` (`'header' | 'body' | 'none'`) — какой дверью
  названа сессия. Попадает в каждое `REAL_REQUEST_START`, поэтому «сессия не
  ходила через прокси» и «ходила, но неназванной» больше не выглядят одинаково.
  Событие `REQUEST_UNIDENTIFIED` называет второй случай прямо.
- Тестовый шов `ProxyClient._sessionPrimedLineages(sessionId)` и набор
  `test/unidentified-request.test.ts` (7 тестов), закрепляющий инвариант.

## [0.20.26] - 2026-06-13 (proxy 1.0.10)

### Fixed
- **False cold-start block of a KA-kept-warm session after a proxy restart**
  (incident 93ef0df0: a 381k warm cache READ was blocked as
  `expected:cold-start` and the user closed the session). Two-layer fix:
  1. `loadPrefixHistory` now prunes by `max(lastReqAt, lastKaAt)` — pruning by
     `lastReqAt` alone dropped every KA-kept-warm idle session's guard history
     on each proxy restart (user idle >1h while KA refreshed every ~28m), so
     its next real request read as a first-ever request.
  2. The guard consults the live KA registry as a second source of truth: an
     `isFirstRequest` whose lineage has a LIVE warm KA snapshot is a cache
     READ — classified quiet, history re-seeded via the normal commit path.

## [0.20.25] - 2026-06-12 (proxy 1.0.9)

### Changed
- **Re-arm endgame cadence (founder refinement of 0.20.24).** The single
  clamped last-chance attempt is replaced by an adaptive cadence: while
  `timeToDeath > 5m` the escalating ladder applies (clamped so a long slot
  lands AT the endgame boundary, never past it); inside the last 5 minutes
  retries run every 30s; inside the last minute every 5s; and a HARD safe
  edge stops all attempts 10s before `cacheDiesAt` (itself already
  `safetyMarginMs` before the true TTL) — double protection against
  local/server clock skew turning a rescue fire into a silent cold rewrite.
  `KA_REARM_SCHEDULED` logs `mode=ladder|endgame|final`.

## [0.20.24] - 2026-06-12 (proxy 1.0.8)

### Changed
- **Re-arm ladder is TTL-sensitive (founder follow-up to 0.20.23).** A ladder
  slot that would land after `cacheDiesAt` is no longer abandoned — it is
  CLAMPED to a last-chance retry at `cacheDiesAt − 5s` (the latest moment a
  fire can still start inside the margin-protected window), so a short-TTL
  session always gets a final recovery attempt before the cache is retired.
  `rearm_outlives_ttl` (clearRegistry) now fires ONLY when even the last
  chance cannot fit (< 1s schedulable). `KA_REARM_SCHEDULED` logs
  `lastChance=true` for clamped slots.

## [0.20.23] - 2026-06-12 (proxy 1.0.7)

Founder directives after the 2026-06-12 14:09Z upstream 401 wave killed ~7 idle
sessions' warm caches (root cause: auth retry-chain exhaust cleared the registry
while 31 min of TTL remained, so the TCP probe's re-fire gate had nothing to revive).

### Changed
- **Keepalive keeps the registry on EVERY retry-chain exhaust while the cache
  TTL has headroom** — auth (401/403) exhausts no longer `clearRegistry()`. A new
  escalating re-arm ladder (`30s → 1m → 2m → 4m → 8m → 10m`, TTL-bounded) retries
  the fire; the hold window also gates interval ticks and probe re-fires, so a
  persistent fault can never hammer upstream in a tight loop. A slot that would
  land after `cacheDiesAt` clears the registry instead (`rearm_outlives_ttl`) —
  the KA never-cold-write invariant holds. Auth-origin exhausts get a distinct
  reason `auth_retry_exhausted` (no TCP probe — the link is fine, the token isn't).
- **Interval ticks are gated while a retry chain owns the fire path**
  (`if (retryTimer) return`) — the incident's confusing parallel second chain
  (exhausting against an already-cleared registry) is structurally impossible now.
- **Error visibility**: the engine records the last KA upstream error
  (status + message) and surfaces it in `KA_CLEAR_DIAG` exhaust lines and the
  `onDisarmed` payload → proxy `KA_DISARM` events now carry `errStatus`/`errMessage`
  (no more proving "it was a 401" from `budget=5` arithmetic).
- **Rewrite guard: huge cold-starts now block too.** New
  `rewriteGuard.minColdStartTokens` (default 150000): an `expected:cold-start`
  first write above it stops for the SAME consent flow (marker / grant). Closes
  the model-switch hole — switching models maps the session to a fresh lineage,
  so a ~272k re-cache previously sailed through with no consent step. Routine
  session starts and compacted resumes sit far below the threshold.
- **quota-watcher self-heals after a traffic-less 5h reset**: a 1s sweep zeroes
  `util5h` (and recomputes levels) the moment `resetAt` passes, forcing an SSOT
  write even with zero traffic — consumers (signal-wire quota hints) no longer
  alarm "0.96 critical" minutes after the window rolled. `util7d` untouched.

## [0.20.20] - 2026-06-09

### Changed
- **Tool-set flick is now OBSERVABILITY, not a block.** Real Anthropic usage proved
  a `WaitForMcpServers` tool drop costs a genuine ~99K prefix re-cache
  (`cacheCreationInputTokens=98974` measured) — but it is the CLIENT's tool set that
  changed (MCP finished connecting → the lifecycle tool is dropped), so it is
  UNAVOIDABLE: blocking just forces consent on a cost the user cannot avoid, and
  fires on every routine MCP reconnect. So `avoidable:lineage-shift` is removed; a
  tool-set change vs a still-warm same-system sibling now classifies as
  `expected:tools-changed` (NEVER blocked) and the proxy emits a concise, once-per-flick
  diagnostic in `PREDICTED_CACHE_MISS`: `[tool-set drift −[WaitForMcpServers] → ~N tok
  re-cache]` — showing exactly which tools changed and the approximate re-cache cost so
  the user can see it without a block or a per-request storm. Net: zero friction, full
  visibility. (Supersedes the blocking 0.20.17–0.20.19, all withdrawn.)

## [0.20.19] - 2026-06-09

### Changed
- **`avoidable:lineage-shift` reworked to a warm-SIBLING signal (system⊕tools
  only) — message-prefix comparison removed.** 0.20.17/0.20.18 compared the
  cacheable MESSAGE prefix up to the last `cache_control` breakpoint, but that
  breakpoint sits on a recent message into which Claude Code injects content
  mid-turn (task-notifications, system-reminders, hook output). So a long live
  session false-blocked on EVERY such injection (a ~400K "rewrite" storm),
  while shorter sessions without injections were spared — which is exactly what
  was observed. Root: the volatile zone is wider than "the last 1–2 messages".
  New detection: a FIRST request for a new `lineageKey` is `avoidable:lineage-shift`
  ONLY when a still-warm SIBLING of the same session + same system-hash (a
  different tool-set) exists within TTL — i.e. the lineage changed because the
  TOOL SET flicked (the proven `WaitForMcpServers` case), detected purely from
  the stable head (system⊕tools), never the message tail. Verified on the real
  incident dumps: the WaitForMcpServers flick flags; a same-lineage request with
  an injected task-notification does NOT. Removed `cacheablePrefixFingerprint`/
  `cacheablePrefixHash`/`lastBreakpointMsgIndex` and the persisted
  `prefixHash`/`breakpointMsgIndex` fields (0.20.17/0.20.18 withdrawn).

## [0.20.18] - 2026-06-09

### Fixed
- **Hotfix for 0.20.17 false-positive storm.** `cacheablePrefixHash` hashed the
  system blocks via `stripCacheControl`, which KEEPS the volatile, non-cached
  `x-anthropic-billing-header` block (its per-request `cch=` token churns every
  request). So a still-warm session's EVERY continuation read as
  `avoidable:lineage-shift` and got blocked — a guard storm across all live
  sessions right after the 0.20.17 deploy. Fix: hash the system component via
  `systemToString` (the same cache_control-only filter `lineageKey` uses), so the
  billing block is excluded and only the genuinely-cached prefix is fingerprinted.
  Verified on real consecutive request bodies: normal turn-growth preserves the
  prefix (no block); a real tool-drop still diverges (protection intact). Added a
  regression test with a realistic billing-header system block. (0.20.17 is
  withdrawn — do not deploy it.)

## [0.20.17] - 2026-06-09

### Fixed
- **Rewrite guard now catches a mid-session cache-prefix divergence
  (`avoidable:lineage-shift`).** A transient MCP-lifecycle tool drop
  (`WaitForMcpServers` on `/login`/resume) flipped the `toolNames` segment of the
  `lineageKey`, so `assessCacheMiss` saw a brand-new key → `isFirstRequest=true` →
  classified `expected:cold-start` → the guard let a ~116K-token cold re-cache
  through silently, abandoning a snapshot KA had kept warm all night. The guard
  now compares the request's **byte-precise cacheable-prefix content hash**
  (system + tools + messages up to the last `cache_control` breakpoint, markers
  stripped) against the warm same-identity snapshot; any divergence before the
  volatile tail → `avoidable:lineage-shift` (blocked + consent marker). Catches
  the proven tool flick AND earlier-message edits (thinking-strip) AND system
  changes, while normal turn-growth (prefix preserved, tail appended) is never
  blocked. Fully body-based + consumer-agnostic (no header dependency); the old
  snapshot keeps being warmed while blocked (proceed-only commit). Orthogonal to
  the org/token axis (`anomalous:org-switch` still outranks). New pure helpers
  `cacheablePrefixFingerprint`/`cacheablePrefixHash`/`lastBreakpointMsgIndex` in
  `lineage.ts`; `prefixHistory` entries now persist `prefixHash`+`breakpointMsgIndex`.

## [0.20.11] / claude-max-proxy [1.0.2] - 2026-06-03

### Added
- **Per-session org/token pinning in the proxy.** A cross-org `claude login` no
  longer blocks or silently migrates live sessions — each session HOLDS its old
  org+token and keeps serving until an explicit switch: the new `[%reload-ok%]`
  marker (per-session), or a cli `reload` (global / per-session). Same-org token
  refresh adopts the fresh token seamlessly. Forced switch only when the held
  token truly expires (→ 401 with reload instructions) or a non-org expensive
  rewrite hits the existing `[%cache-rewrite-ok%]` guard. Pins are in-memory
  (proxy restart → rebind to current org).
- **`OrgIdResolver.invalidate()`** + **`ProxyClient.notifyCredentialsChanged()`**,
  called from the daemon credentials `fs.watch`, so the token cache and the
  org-id cache invalidate in lock-step — closes the ~5-min stale-org detection
  window that let real traffic slip onto a new org silently.
- **`reloadMarker`** config (`[%reload-ok%]`, SSOT + hot-reload), distinct from
  `overrideMarker`. **`ICredentialsProvider.currentExpiresAt()`** (optional) so
  the pin can detect a truly-expired held cross-org token.

### Changed
- Cross-org no longer routes through the rewrite-guard 400 path for real traffic
  (it HOLDS instead). The guard's 400 remains for non-org expensive rewrites.
- `orgSwitchPending` lifecycle is now pin-driven (set while held, cleared on
  rebind); `notifyRealRequestComplete` no longer auto-clears it.

## [0.12.0] / opencode-claude [1.3.0] / claude-max-proxy [0.6.0] - 2026-04-30

### Added
- **`src/keepalive-config.ts` — SSOT for cache & keepalive parameters.**
  All knobs (cacheTtlMs, safetyMarginMs, intervalMs, retryDelaysMs,
  rewriteWarn*, healthProbe*, idleTimeoutMs, minTokens, enabled) live in one
  place, hot-reloaded from `~/.claude/keepalive.json` on each access.
  Auto-scales sensibly: 5m TTL → 150s interval, 1h TTL → 1800s interval, with
  the upper interval clamp computed dynamically as `cacheTtlMs - safetyMarginMs - 60s`.
  Test-time isolation via `CLAUDE_KEEPALIVE_CONFIG_PATH` env override.

- **`src/cache-metrics.ts` — rolling-window metrics + regression detector.**
  Tracks hit_rate, cache_read avg/max, cold-start count, distinct sysHash count.
  Emits `CACHE_METRICS_SUMMARY` every 60s and `CACHE_REGRESSION_DETECTED` if
  hit_rate drops from healthy (>=85%) to bad (<70%) — surfaces silent
  Anthropic-side cache changes within an hour of regression.

- **`bunfig.toml` + `test/_setup-keepalive-fixture.ts`** — preload hook ensures
  tests see a stable fixture config regardless of host's `~/.claude/keepalive.json`.

- **Prefix fingerprint logging** (`provider.ts:convertPrompt`).
  Each system block hashed separately (`fingerprints=[hash@len, ...]`) so
  cross-PID cache misses can be diagnosed by comparing fingerprints between
  STARTUP logs.

- **Tool schema drift detector** (`provider.ts:convertTools`).
  Beyond name-set changes (`TOOL_DRIFT`), now also detects `TOOL_SCHEMA_DRIFT`
  when tool *bodies* (descriptions/schemas) change while names stay the same.
  Caught mid-session schema mutations from MCP servers (e.g. telegram-mcp_tg_send_message).

### Fixed
- **1h cache TTL is now actually used.** The `prompt-caching-scope-2026-01-05`
  beta is honoured by Anthropic on the OAuth subscription endpoint —
  empirically confirmed: WRITE → READ at T+5m30s, T+10m, T+30m all hit with
  `cache_read_input_tokens > 0`. Engine's hardcoded `CACHE_TTL_MS = 5 * 60 * 1000`
  removed; `cacheTtlMs` is now an instance field initialized from SSOT.
  Default keepalive interval scales from 2 min → 30 min when 1h TTL active —
  **15× fewer keepalive fires** per session.

- **`addCacheMarkers` clamp tightened**. The legacy `intervalMs` upper bound
  240_000 was hardcoded for 5-minute TTL; now derived as
  `cacheTtlMs - safetyMarginMs - 60_000`, allowing intervals up to ~58 min on
  1h TTL without clamp.

- **`todo_write` no longer drifts between builtin and MCP buckets.**
  Pre-fix, `MCP_TOOL_PATTERN /^[a-z][\w-]+_[a-z]/` matched `todo_write` (after
  `TOOL_NAME_REMAP` from `todowrite`), classifying it as MCP. Whenever
  `todo_write` appeared/disappeared, the alphabetically-sorted MCP block
  shifted, breaking cache prefix. Observed 319× over the past month
  (`TOOL_DRIFT 80↔79 (builtin=10 mcp=69)` pattern).
  Now uses an explicit `BUILTIN_NAMES_AFTER_REMAP` allowlist.

- **MEMORY.md split out of stable prefix** (`provider.ts:buildContextInjectionParts`).
  Pre-fix: CLAUDE.md + MEMORY.md were both prepended at the front of system,
  so any MEMORY.md growth (agents write to it) invalidated the entire 36 KB+
  prefix. Now: CLAUDE.md prepended (stable), MEMORY.md *appended* (volatile).
  Growth in MEMORY.md only invalidates the trailing segment.

- **`rewriteWarnIdleMs` auto-scales with `cacheTtlMs`.**
  Default was 300_000 (5 min) — when 1h TTL active, this fired the
  `[claude-max] Cache likely dead — idle=375s, next request will cost ~520972
  cache_write tokens` banner every 5 min of user idleness while cache was
  *actually* fine. Now defaults to `cacheTtlMs - safetyMarginMs` (close to TTL
  boundary), matching the actual time when cache could plausibly be dead.

- **Disk-mtime token reload on every `ensureAuth` call.**
  `_doEnsureAuth` (sdk.ts:919) and `CredentialManager.ensureValid`
  (opencode-claude/index.ts:134) used to fast-path return when the in-memory
  token wasn't expired, never reading the disk. After a `claude login` while a
  process was running, the in-memory token stayed alive ~8h, pinning the
  process to the old org. Live demo on 2026-04-30: org A hit `util_5h=1.0,
  status=rejected, retry-after=5516s`, but the running PID kept retrying with
  the old token instead of picking up the new credentials sitting on disk.
  Now: every request first checks `credentialStore.hasChanged()` (cheap mtime
  check) and reloads on change — with no impact on the non-rotation path.

### Changed
- **`KeepaliveEngine.CACHE_TTL_MS` → `this.cacheTtlMs`** (instance field).
  Ditto `CACHE_SAFETY_MARGIN_MS`, `KEEPALIVE_RETRY_DELAYS`, `HEALTH_PROBE_INTERVALS_MS`,
  `HEALTH_PROBE_TIMEOUT_MS`. All read from SSOT via `loadKeepaliveConfig()`
  in the constructor. Ten internal use-sites updated.

- **Live-reload mechanism unified.** Removed duplicate
  `KEEPALIVE_CONFIG_PATH` + `readKeepaliveConfig()` from
  `keepalive-engine.ts`; tick() now calls `loadKeepaliveConfig()` directly
  (mtime-cached inside SSOT module).

- **`ProxyClient.kaIntervalSec` defaults to undefined**, deferring to SSOT.
  Same change in `claude-max-proxy/src/config.ts` (`KA_INTERVAL_SEC` env
  override still works) and `opencode-claude/provider.ts`
  (`CLAUDE_MAX_KEEPALIVE_INTERVAL` env override still works).

- **`/stats` endpoint** (claude-max-proxy) now exposes resolved `cacheConfig`
  + rolling `cacheMetrics` for live observability of the SSOT and hit-rate.

- **STARTUP log marker** in `createClaudeMax`:
  `STARTUP createClaudeMax pid=… sdk=0.12.0 plugin=1.3.0 [cache-ssot]
  cacheConfig={cacheTtlMin:60, intervalMin:30, …}`. Trivial check that a
  process loaded the new code by greping for `[cache-ssot]`.

### Activated by writing to `~/.claude/keepalive.json`
```json
{
  "enabled": true,
  "cacheTtlSec": 3600,
  "safetyMarginSec": 60,
  "intervalSec": 1800,
  "retryDelaysSec": [2, 3, 5, 10, 15, 20, 30, 60, 120, 300]
}
```
Without this file, defaults fall back to legacy 5m TTL behaviour for safety.

## [0.11.4] - 2026-04-27

### Fixed
- **Token refresh 429 storms — three independent root causes addressed.**
  Production incident on 2026-04-27 04:50:54Z reproduced the same `429 Too
  Many Requests` pattern that we thought was fully fixed in 0.11.1. Detailed
  log analysis revealed the lock fix worked perfectly *between our PIDs*, but
  three other paths still produced the storm:

  1. **Within a single PID we hammered the endpoint 5× in 13 seconds.** On the
     first 429, our retry loop slept the configured `[500, 1500, 3000, 5000,
     8000]ms` delays and POSTed again — but Anthropic's per-`refresh_token`
     rate window is on the order of **60 seconds**. Every retry just *extended*
     the window we were already locked out of.
  2. **`PROACTIVE_REFRESH_RATIO=0.50` was too aggressive.** Refreshing at 50%
     of remaining lifetime triggers ~6 fetches/day per refresh_token. Standard
     OAuth clients (and the original Claude Code CLI) refresh at 5–15% remaining
     or reactively on 401. Our cadence alone was enough to flag us with
     Anthropic as a "noisy" client.
  3. **No coordination with non-SDK refreshers.** The original Claude Code CLI
     reads/writes the same `~/.claude/.credentials.json` but knows nothing
     about our `~/.claude/.token-refresh-lock/` directory. When CLI was
     mid-refresh and our SDK fired its own scheduled rotation, both POSTed
     simultaneously — and Anthropic's rate-limit hit our SDK harder (the CLI
     wins the race per logs from 04:51:32Z).

### Changed
- `PROACTIVE_REFRESH_RATIO` lowered from `0.50` → `0.20`. With an 8h token
  this moves first refresh from "4h after issue" to "6h 24min after issue"
  (96min remaining), cutting fetch frequency from ~6/day to ~1.2/day per
  refresh_token while preserving plenty of margin for retries.
- `doTokenRefresh()` now **bails out immediately on the first 429** instead
  of retrying 4 more times. Sets a flat 60-second cross-process cooldown
  (`setRefreshCooldown(60_000)`) so other PIDs and our own next scheduled
  rotation back off long enough to clear Anthropic's window. The 5× retry
  loop is preserved only for genuine `5xx` server errors.
- `doTokenRefresh()` performs a **mtime check** on `~/.claude/.credentials.json`
  before its first POST. If the file was modified within the last 60 seconds,
  the SDK reads the file and uses whatever fresh token landed there — whether
  it was written by another of our PIDs, the original Claude Code CLI, or any
  other process sharing the credential file. This is the only practical way to
  coordinate with closed-source CLI without modifying it.
- `FileCredentialStore.path` changed from `private` to `public readonly` so
  `doTokenRefresh()` can perform the mtime check without a separate API.

### Tests
- New file `test/token-refresh-coord.test.ts`: 6 tests covering
  `FileCredentialStore.path` accessibility, mtime classification of
  recent vs stale writes, `read()` parsing, and missing-file behavior.
- Total: 36 pass / 0 fail across `keepalive-engine`, `keepalive-regression`,
  and `token-refresh-coord` suites.

## [0.11.3] - 2026-04-26

### Fixed
- **`AbortError`/timeout misclassified as `server_transient` → fake
  `cache_ttl_exhausted` disarms.** Production logs on 2026-04-26 18:44Z
  showed two consecutive incidents:

  ```
  18:44:31  API_ERROR pid=2649955 ttfb=245497ms err=The operation timed out.
  18:44:31  keepalive DISARMED reason=cache_ttl_exhausted
  18:46:14  API_ERROR pid=2299636 ttfb=259957ms err=The operation timed out.
  18:46:14  keepalive DISARMED reason=cache_ttl_exhausted
  ```

  Anthropic API hung for ~4 minutes on real requests. The SDK's request-level
  timeout (`sdk.ts:234`, default 600s) eventually fired `controller.abort()`,
  fetch threw `AbortError`, and the SDK wrapped it as
  `ClaudeCodeSDKError('Network error', err)`. The engine's `classifyError()`
  only inspected `e.code`/`e.cause.code`/`e.message`, none of which contained
  any of the network keywords — so it fell through to `server_transient`,
  rolled into `retryChain()`, and then disarmed with the lying reason
  `cache_ttl_exhausted` (the cache hadn't expired by TTL — the *retries* did).
  Two days of debugging traced this exact cause back to the engine
  misclassification.

### Changed
- `classifyError()` now walks the full `.cause` chain, recognises
  `AbortError`/`TimeoutError` by `name`, matches additional message keywords
  including the literal SDK wrapper text `'Network error'`, and adds Bun /
  Undici codes (`ABORT_ERR`, `ERR_NETWORK`) plus phrases (`'aborted'`,
  `'the operation timed out'`, `'fetch failed'`, `'socket hang up'`,
  `'terminated'`).
- `retryChain()` emits a new, more honest reason when retries — not idle —
  consumed the cache window: `retry_budget_exceeds_ttl` (cache was still
  fresh-ish when retries started but the next backoff would land past TTL).
  The old `cache_ttl_exhausted` reason is preserved only for the genuine
  case where the cache aged past half-TTL before failures began. Both reasons
  now trigger `startHealthProbe()` so a recovering network is detected fast.

### Tests
- 5 new regression tests in `Layer 4: error classification`:
  - `AbortError (request timeout) → classified as network, NOT cache_ttl_exhausted`
  - `"The operation timed out." message → classified as network`
  - `TimeoutError name → classified as network`
  - `plain "Network error" (SDK wrapper with no cause details) → classified as network`
  - `ECONNRESET → still classified as network (regression guard)`
- 23 pass / 0 fail.

## [0.11.2] - 2026-04-26

### Fixed
- **False "Cache likely dead" warnings while KA is healthy.**
  `KeepaliveEngine.checkRewriteGuard()` measured idle time against
  `lastRealActivityAt` (only updated by real user requests), causing the TUI to
  display `⚠️ [claude-max] Cache likely dead — idle=350s, next request will cost
  ~150k cache_write tokens` every 5 minutes of user idleness — even when KA fires
  were continuously refreshing the prompt cache and Anthropic was returning low
  `cache_creation_input_tokens` (< 2k) on real requests, proving the cache was
  actually warm.
  Guard now measures against `cacheWrittenAt`, which is updated by both real
  requests **and** successful KA fires (line 504). Result: warnings appear only
  when the cache is genuinely stale (KA broken / DISARMED / engine stopped),
  not on every period of user idleness.

### Tests
- 4 existing rewrite-guard tests migrated from `_setLastRealActivityAt` to
  `_setCacheWrittenAt` to reflect the new (correct) semantics.
- 2 new regression tests:
  1. `no warn when KA recently fired (cacheWrittenAt is fresh) even after long user idle`
  2. `warn DOES fire when cacheWrittenAt is stale (KA broken or DISARMED)` —
     ensures the guard still works correctly when KA actually fails.
- New test helpers `_setCacheWrittenAt(v)` and `_cacheWrittenAt` getter.

## [0.11.1] - 2026-04-26

### Fixed
- **Token refresh 429 storm** — when N opencode PIDs running on the same machine
  rotated their OAuth tokens at similar times, the cross-process file lock
  (`~/.claude/.token-refresh-lock`) only retried for ~10s before giving up and
  returning `null`. Callers ignored the `null` and proceeded to call the OAuth
  endpoint anyway — producing 3+ simultaneous `POST /v1/oauth/token` requests
  that Anthropic answered with 429. Each PID then entered its own retry loop
  (`TOKEN_REFRESH_RETRY status=429 attempt=1/5` …), failing repeatedly for
  several minutes. Meanwhile the prompt cache (5 min TTL) drained, and
  keepalive eventually disarmed with `cache_ttl_exhausted` because no valid
  token was available to fire heartbeats. (Symptom in logs:
  `keepalive DISARMED reason=cache_ttl_exhausted` immediately after a TOKEN_ROTATION
  429 cluster.)

### Changed
- `acquireTokenRefreshLock()` budget raised from 5 to 30 attempts (~10s → ~45s),
  comfortably covering the worst-case real refresh of ~25-30s (5 fetch attempts
  with `[500, 1500, 3000, 5000, 8000]`ms backoff plus network RTT).
- All three call sites (`proactiveRefresh()`, `refreshTokenWithTripleCheck()`,
  `handleAuth401()`) now **fail-closed** when the lock is unavailable: instead
  of joining the storm, the loser polls the credential store on disk for the
  fresh token the winner is about to write. New helper `pollDiskForFreshToken()`
  encapsulates this.
- Last-resort unlocked refresh kept only as a safety net for
  `refreshTokenWithTripleCheck()` and `handleAuth401()` when no fresh token
  appears within 45s — proactive rotation never falls through, since the timer
  will fire again soon and the system will eventually converge.

## [0.5.0] - 2026-04-04

### Added
- **Voice input** — `/voice` command (or `/v`) toggles voice-to-text recording in opencode TUI
- **Voice STT** — streams mic audio to Anthropic's Deepgram-powered WebSocket endpoint (`wss://api.anthropic.com/api/ws/speech_to_text/voice_stream`)
- **Recording indicator** — `app` slot overlay shows "🔴 Recording..." with live interim transcript
- **Silence auto-stop** — recording stops after configurable silence period (default 3s, via `voiceSilenceMs` in api.kv)
- **Voice dependency check** — detects SoX/arecord, shows install hint via toast if missing
- **Voice config** — `voiceEnabled` and `voiceSilenceMs` persisted via opencode's `api.kv`
- **Text injection** — transcribed text inserted into prompt via `api.client.tui.appendPrompt()` with HTTP fallback
- **Lifecycle cleanup** — mic process killed and WebSocket closed on plugin dispose

### Technical
- All voice functions inlined in tui.tsx (avoids cross-process import issues)
- Raw WebSocket implementation (RFC 6455 frame parsing, no ws dependency)
- PCM 16kHz/16-bit/mono via SoX `rec` or ALSA `arecord`
- RMS-based silence detection with configurable threshold
- Toggle UX (not hold-to-talk — terminal key release detection too fragile)

## [0.4.1] - 2026-04-04

### Fixed
- **Tool order non-deterministic** — MCP servers register tools in startup-race order, causing cache prefix to diverge at tool ~#11 across processes. All processes now sort tools by name before sending to API, producing identical prefixes regardless of MCP server startup timing.

## [0.4.0] - 2026-04-04

### Fixed
- **Token refresh stampede** — 6 concurrent sessions detecting expired token simultaneously caused 1064 simultaneous refresh requests, all getting 429, resulting in 40-minute outages. Root cause: no cross-process coordination.

### Added
- **Filesystem lock** (`mkdir`-based) for token refresh — only one process refreshes at a time, others wait and read from disk. Lock at `~/.claude/.token-refresh-lock/` with 30s stale timeout and PID file.
- **Triple-check pattern** — Check 1 (cached), Check 2 (re-read store), acquire lock, Check 3 (post-lock re-read). Prevents double-refresh across processes.
- **ensureAuth dedup** — concurrent calls within one process share a single pending promise instead of each triggering independent refresh.
- **Race recovery** — after all refresh retries fail, re-reads credential store one final time in case another process succeeded. Logs `TOKEN_REFRESH_RACE_RECOVERY` on success.

### Changed
- Token refresh now coordinates across processes: ≤5 endpoint requests per cycle instead of 1064
- Session recovery from token expiry: ~5 seconds instead of ~40 minutes

## [0.3.3] - 2026-04-04

### Fixed
- **Cost display bug** — auth.loader was zeroing out model costs after config hook set them, causing sidebar to show "N/A savings" instead of actual dollar savings

### Added
- **Keepalive config via opencode.json** — `options.keepalive` (bool), `options.keepaliveInterval` (seconds), `options.keepaliveIdle` (seconds) in provider config, with env var fallback
- **Compaction hook** — `experimental.session.compacting` injects cache optimization context into compaction summaries; optional full prompt replacement via `options.customCompaction`
- **Fine-grained tool streaming** — `fine-grained-tool-streaming-2025-05-14` beta header enables streaming partial tool arguments

### Changed
- Provider options from `opencode.json` now flow through to `createClaudeMax()` for runtime configuration

## [0.3.2] - 2026-04-04

### Fixed
- **Keepalive snapshot protection** — subagent calls (Task tool spawns) could overwrite the main conversation's keepalive snapshot with a tiny context, causing the main conversation's cache to expire during idle periods. Fix: never downgrade snapshot — only overwrite if new call has more tokens than existing.

## [0.3.1] - 2026-04-04

### Added
- **TUI Plugin: Cache Stats Sidebar** — real-time cache read/write tokens, hit ratio %, and estimated cost savings visible in opencode sidebar (`Ctrl+X B`)
- **TUI Plugin: `/cache` Command** — diagnostics dialog with keepalive fire history, API response time percentiles (min/p50/max), live config display, and active sessions list
- **Cross-Project Cache Sharing** — CWD paths normalized in tool schemas so all projects share the same ~30K token tool prefix (saves ~33K tokens per new project session)
- **Live-Reload Keepalive Config** — `~/.claude/keepalive.json` read on each tick with mtime caching; change interval, idle timeout, or kill switch without restarting
- **Image Resize Pipeline** — automatic resize via jimp to Anthropic's native 1568px long edge; PNG preserved for screenshots, JPEG fallback for oversized images
- **Equivalent API Pricing** — model config includes Anthropic per-token rates so sidebar shows estimated savings (e.g. "$179 saved") instead of "N/A"

### Fixed
- **Image Support** — added `modalities` config (not just `capabilities`) so opencode passes images through instead of stripping with "model does not support image input" error
- **Data URL Safety** — strip `data:` prefix if AI SDK passes full data URL instead of pure base64
- **Oversized Image Handling** — reject images >5MB with user-visible message instead of crashing

### Changed
- **Keepalive: No Idle Timeout** — empirically verified keepalives cost zero quota (0.00 util5h across 185 fires); sessions now keep cache warm for process lifetime
- **Image Resize Target** — 1568px long edge (was 2000px) matching Anthropic vision model's native resolution; saves ~38% tokens with zero quality loss
- **Dead Code Removed** — `computeFingerprint`, `hashFingerprint`, `FINGERPRINT_SALT` removed from SDK

### Performance
- 99.5% cache hit ratio observed (13.7M read / 64.7K write in production session)
- 163K token cross-session cache hit on session restart
- Keepalive overhead: 183 output tokens/day (0.04% of real traffic)
- Image resize: <100ms via jimp (pure JS, no native deps)

## [0.3.0] - 2026-04-03

### Added
- Cache keepalive with 120s interval, jitter, retry chain
- Image/PDF content block support in provider
- Voice STT module (`src/voice.ts`) with WebSocket streaming
- Voice transcription examples
- API timing logs (TTFB) and raw body dumps (first 3 calls)
- Document content block type in types

### Fixed
- Simplified to 1-marker cache strategy (matches Claude Code)
- Deep-copy system prompt to prevent `cache_control` mutation leaking
- Deterministic billing header (stripped per-message fingerprint)
- `.gitignore` was using literal `\n` instead of newlines (no rules worked)

### Changed
- Context window: 1M for Opus/Sonnet on Max subscription
- Keepalive interval: 120s (was 270s)
- Compaction disabled in test configs

## [0.2.0] - 2026-04-01

### Added
- Structured JSONL stats log with utilization metrics (5h/7d)
- Session slug + PID in all stats log entries
- Rate limit header dumping for discovery

### Changed
- Keepalive interval tuning (270s → 240s → 120s progression)

## [0.1.2] - 2026-03-31

### Fixed
- Token usage display: total includes cache
- Provider metadata for opencode cache tracking

## [0.1.1] - 2026-03-30

### Fixed
- Surface rate limit and API errors during streaming
- Proxy stays alive with multiple clients

## [0.1.0] - 2026-03-29

### Added
- Initial release
- ClaudeCodeSDK: OAuth auth, streaming, tool use, thinking
- OpenCode plugin: provider registration, model config
- FileCredentialStore with mtime-based refresh detection
- Keepalive system for prompt cache preservation
