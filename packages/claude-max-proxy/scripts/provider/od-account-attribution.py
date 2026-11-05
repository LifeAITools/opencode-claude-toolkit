#!/usr/bin/env python3
"""
Опыт: принадлежат ли ДВА ключа OpenDesign ОДНОМУ счёту или разным организациям.

ЗАЧЕМ: у LiteLLM два развёртывания `deepseek-v4.1-flash-od` с разными ключами, и нужно
понять, разные это аккаунты или один счёт.

🔴 ОПЫТ 05.11.2026 ДАЛ НЕВЕРНЫЙ ВЫВОД — И ЭТО ЗАПИСАНО ЗДЕСЬ, ЧТОБЫ НЕ ПОВТОРИТЬ.
Первый прогон дал 36 375 → +5 → +24 и был прочитан как «счётчик двигается от обоих ключей,
значит счёт один». Вывод неверен: на том же счёте ПОСТОЯННО работает флот (497 успешных
вызовов за час), дельта не приписывается нашим десяти вызовам. Метод ниже измеряет
СОВОКУПНЫЙ счёт и для атрибуции ключа годится ТОЛЬКО на молчащем аккаунте.

ПРИБОР, КОТОРЫЙ РЕАЛЬНО РАЗЛИЧАЕТ КЛЮЧИ, НУЖНО ИСКАТЬ ДРУГОЙ: с инференса принадлежность
не видна (в ответе лишь `extra_fields.routing_info {provider, model, key}`), `/v1/me` — 404,
списка ключей нет (все пути 404). Пока источник — владелец аккаунта.

Секреты не печатаются и не сохраняются: ключи читаются из файлов на месте.
"""
import json,os,re,urllib.request,urllib.error,time

CTRL='https://amr-api.open-design.ai'
creds=json.load(open(os.path.expanduser('~/.secrets/open-design-control.json')))
ck=creds['controlKey']

def api(path):
    r=urllib.request.Request(CTRL+path,headers={'authorization':f'Bearer {ck}','accept':'application/json','user-agent':'probe/1.0'})
    with urllib.request.urlopen(r,timeout=20) as res:
        return json.loads(res.read().decode() or 'null')

ws=api('/api/v1/workspaces')
items=(ws or {}).get('items') or []
def snap():
    out={}
    for w in items:
        wid=w['workspaceId']; name=w.get('workspaceName')
        try:
            pf=api(f'/api/v1/workspaces/{wid}/billing/preflight')
        except Exception as e:
            out[name]=f'ERR {e}'; continue
        cp=pf.get('codingPlan') or {}
        wins=[(int(x.get('durationSeconds',0)), x.get('usedCredits'), x.get('limitCredits')) for x in (cp.get('windows') or [])]
        out[name]={'eligible':cp.get('eligible'),'windows':wins,'balance':pf.get('balanceUsd')}
    return out

print('BEFORE',json.dumps(snap(),ensure_ascii=False))

# keys
env={}
for line in open('/home/relishev/projects/vibe/kiberos-app/litellm/.env',encoding='utf-8'):
    m=re.match(r'\s*(OPEN_DESIGN_API_KEY(?:_2)?)\s*=\s*(.+)\s*$',line)
    if m: env[m.group(1)]=m.group(2).strip().strip('"').strip("'")

def hit(key):
    body=json.dumps({'model':'deepseek-v4.1-flash','max_tokens':4,'messages':[{'role':'user','content':f'number {time.time()}'}]}).encode()
    r=urllib.request.Request('https://amr-link.open-design.ai/v1/chat/completions',data=body,
        headers={'authorization':f'Bearer {key}','content-type':'application/json'})
    with urllib.request.urlopen(r,timeout=45) as res:
        return res.status

for tag,k in (('KEY1',env.get('OPEN_DESIGN_API_KEY')),('KEY2',env.get('OPEN_DESIGN_API_KEY_2'))):
    ok=0
    for i in range(5):
        try: ok+= 1 if hit(k)==200 else 0
        except Exception as e: print(tag,'err',e)
    time.sleep(2)
    print(tag,'ok',ok,'AFTER',json.dumps(snap(),ensure_ascii=False))
