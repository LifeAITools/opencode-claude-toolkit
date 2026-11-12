import json, numpy as np, sys
from datetime import datetime
ORGS=('b3219c9b','02b4bfd1','f9420373','35140078')
def fam(m):
    for f in ('opus','sonnet','haiku','fable'):
        if f in m: return f
    return 'other'
FAM=['opus','sonnet','haiku','fable','other']
rows=[]; ses_ids={}; full_org={}
skipped=dict(bad=0,nonstream=0,noorg=0,synthetic=0,nousage=0)
with open('/home/relishev/.claude-local/claude-max-stats.jsonl','rb') as f:
    for l in f:
        try: d=json.loads(l)
        except Exception: skipped['bad']+=1; continue
        if not isinstance(d,dict): skipped['bad']+=1; continue
        if d.get('type')!='stream': skipped['nonstream']+=1; continue
        o=d.get('org')
        if not o: skipped['noorg']+=1; continue
        oi=None
        for i,p in enumerate(ORGS):
            if o.startswith(p): oi=i; full_org[i]=o
        if oi is None: skipped['synthetic']+=1; continue
        u=d.get('usage')
        if not isinstance(u,dict): skipped['nousage']+=1; continue
        try: t=datetime.fromisoformat(d['ts'].replace('Z','+00:00')).timestamp()
        except Exception: skipped['bad']+=1; continue
        r=d.get('rateLimit') or {}
        def g(k):
            v=r.get(k); return float(v) if isinstance(v,(int,float)) else np.nan
        s=d.get('ses') or '?'
        si=ses_ids.setdefault(s,len(ses_ids)) if s!='?' else -1
        def ui(k):
            v=u.get(k); return float(v) if isinstance(v,(int,float)) else 0.0
        rows.append((t,oi,si,FAM.index(fam(str(d.get('model','')))),g('util5h'),g('util7d'),g('resetAt'),g('resetAt7d'),
                     ui('in'),ui('out'),ui('cacheRead'),ui('cacheWrite')))
a=np.array(rows,dtype=np.float64)
a=a[np.argsort(a[:,0],kind='stable')]
np.savez('/home/relishev/projects/vibe/claude-code-sdk/research/placement-pid-scripts/turns.npz',a=a,orgs=np.array([full_org[i] for i in range(4)]),skipped=json.dumps(skipped),nses=len(ses_ids))
print(a.shape,skipped,len(ses_ids))
