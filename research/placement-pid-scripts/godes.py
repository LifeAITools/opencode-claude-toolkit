import json, re, collections, numpy as np, glob
from datetime import datetime
from scipy.optimize import nnls
def ts(s): return datetime.fromisoformat(s.replace('Z','+00:00')).timestamp()
S=[json.loads(l) for l in open('/home/relishev/.claude-local/quota-samples.jsonl')]
util=collections.defaultdict(list)  # (prov,acct)->[(t,u5)]
for x in S:
    t=ts(x['measured_at'])
    for o in x['orgs']:
        w={k['window']:k.get('util') for k in o.get('windows',[])}
        if w.get('5h') is not None: util[(x['provider'],o['name'])].append((t,w['5h']))
# OD activity
act=collections.defaultdict(list)  # (prov,acct)->[(t,session,model)]
rx=re.compile(r'аккаунт (\S+)')
for l in open('/home/relishev/.claude-local/claude-max-proxy.jsonl'):
    if '"OD_REQUEST"' not in l and '"GO_COMPLETE"' not in l: continue
    try: d=json.loads(l)
    except: continue
    if d['kind']=='OD_REQUEST':
        m=rx.search(d.get('msg','')); 
        if m: act[('open-design',m.group(1))].append((ts(d['ts']),d.get('sessionId'),d.get('model')))
    else:
        if d.get('callKind')=='real' and d.get('org'): act[('opencode-go',d['org'])].append((ts(d['ts']),d.get('sessionId'),d.get('model')))
for f in sorted(glob.glob('/home/relishev/.claude-local/go-spend-*.jsonl')): pass
out={}
for prov in ('open-design','opencode-go'):
    X=[];Y=[];meta=collections.Counter(); models=collections.Counter(); per=[]
    for (p,acct),ser in util.items():
        if p!=prov: continue
        ser.sort(); ev=sorted(act.get((p,acct),[]))
        et=np.array([e[0] for e in ev]) if ev else np.array([])
        for (t0,u0),(t1,u1) in zip(ser,ser[1:]):
            if t1-t0>900: continue
            dy=u1-u0
            if dy<-0.005: meta['reset_or_drop']+=1; continue
            lo,hi=np.searchsorted(et,t0),np.searchsorted(et,t1)
            ss={ev[i][1] for i in range(lo,hi)}
            for i in range(lo,hi): models[ev[i][2]]+=1
            X.append(len(ss)*(t1-t0)/3600); Y.append(dy); per.append(acct)
    X=np.array(X);Y=np.array(Y)
    if len(X)==0: continue
    c,_=nnls(np.column_stack([X,np.ones(len(X))]),Y)
    m=X>0
    out[prov]=dict(intervals=len(X),intervals_with_sessions=int(m.sum()),session_hours=float(X.sum()),
        K_per_session_hour=float(c[0]),intercept_per_interval=float(c[1]),
        total_dU=float(Y[Y>0].sum()),ratio_K=float(Y.sum()/X.sum()) if X.sum() else None,
        accounts_with_activity=len({a for a,x in zip(per,X) if x>0}),drops_skipped=meta['reset_or_drop'],models=dict(models.most_common(6)))
print(json.dumps(out,indent=1))
