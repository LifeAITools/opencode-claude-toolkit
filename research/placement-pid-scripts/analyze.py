import numpy as np, json, gzip, collections, re
from datetime import datetime, timezone
from scipy.optimize import nnls
z=np.load('/home/relishev/projects/vibe/claude-code-sdk/research/placement-pid-scripts/turns.npz'); a=z['a']; ORGS=list(z['orgs'])
T,O,S,F,U5,U7,R5,R7,IN,OUT,CR,CW=range(12)
FAM=['opus','sonnet','haiku','fable','other']; CLS=['anthropic/'+f for f in FAM]
B=300.0
R={}  # results
def q(x,ps=(10,50,90)):
    x=np.asarray(x,float); x=x[~np.isnan(x)]
    return [float(np.percentile(x,p)) for p in ps] if len(x) else [None]*len(ps)
# ---------- 1. buckets
bk=np.floor(a[:,T]/B).astype(np.int64)
ses=a[:,S].astype(np.int64); org=a[:,O].astype(int); fam=a[:,F].astype(int)
first_seen={}  # session -> (bucket) first turn
sess_first=collections.OrderedDict(); sess_last={}; sess_org={}; sess_turns=collections.Counter()
sess_famc=collections.defaultdict(collections.Counter); sess_buckets=collections.defaultdict(set)
for i in range(len(a)):
    s=ses[i]
    if s not in sess_first: sess_first[s]=a[i,T]; sess_org[s]=org[i]
    sess_last[s]=a[i,T]; sess_turns[s]+=1; sess_famc[s][fam[i]]+=1; sess_buckets[s].add(bk[i])
sess_cls={s:c.most_common(1)[0][0] for s,c in sess_famc.items()}
buckets={}  # (org,bk) -> dict
order=np.lexsort((a[:,T],bk,org))
for i in order:
    key=(org[i],bk[i]); d=buckets.get(key)
    if d is None:
        d=buckets[key]=dict(u5=np.nan,u5max=np.nan,u7=np.nan,r5=np.nan,n=0,ses=set(),new=set(),scls=collections.defaultdict(set),
                            tok=np.zeros(4),tokc=np.zeros((5,4)))
    if not np.isnan(a[i,U5]):
        d['u5']=a[i,U5]; d['u5max']=a[i,U5] if np.isnan(d['u5max']) else max(d['u5max'],a[i,U5])
    if not np.isnan(a[i,U7]): d['u7']=a[i,U7]
    if not np.isnan(a[i,R5]): d['r5']=a[i,R5]
    d['n']+=1; s=ses[i]; d['ses'].add(s); d['scls'][fam[i]].add(s)
    if sess_first[s]==a[i,T]: d['new'].add(s)
    tk=a[i,[IN,OUT,CR,CW]]; d['tok']+=tk; d['tokc'][fam[i]]+=tk
# ---------- windows per org (cummax envelope)
series={}
nwin=0; resets_by=collections.Counter()
for o in range(4):
    ks=sorted(k for k in buckets if k[0]==o); rows=[]
    env=np.nan; wid=None; prev_b=None; prev_r5=np.nan
    for k in ks:
        d=buckets[k]; reset=None
        if wid is None: reset='start'
        elif not np.isnan(d['u5max']) and not np.isnan(env) and d['u5max']<=env-0.05: reset='drop'
        elif not np.isnan(d['r5']) and not np.isnan(prev_r5) and abs(d['r5']-prev_r5)>=3600 and k[1]*B>=prev_r5-60: reset='resetAt'
        elif prev_b is not None and (k[1]-prev_b)*B>=5*3600: reset='gap5h'
        if reset:
            nwin+=1; wid=nwin; env=np.nan; resets_by[reset]+=1
        if not np.isnan(d['u5max']): env=d['u5max'] if np.isnan(env) else max(env,d['u5max'])
        if not np.isnan(d['r5']): prev_r5=d['r5']
        d['env']=env; d['wid']=wid; d['reset']=reset; prev_b=k[1]
        rows.append(k)
    series[o]=rows
R['windows']=dict(n=nwin,reasons=dict(resets_by))
# ---------- 2. plant gain
# per-bucket session-hours by class, tokens
def win_rows():
    W=collections.defaultdict(list)
    for o in range(4):
        for k in series[o]: W[buckets[k]['wid']].append(k)
    return W
W=win_rows()
# hourly chunks within windows: Δenv between consecutive chunk-ends (first chunk baseline = first measured env)
X_s=[];X_t=[];Y=[];CH=[]; per_win=[]
for wid,ks in W.items():
    o=ks[0][0]; ks=sorted(ks,key=lambda k:k[1])
    span_h=(ks[-1][1]-ks[0][1])*B/3600
    base=buckets[ks[0]]['env']
    if np.isnan(base): continue
    # attribute first bucket's activity to baseline (not observed before)
    chunks=collections.OrderedDict()
    for k in ks[1:]:
        c=(k[1]-ks[0][1])//12; chunks.setdefault(c,[]).append(k)
    tot_sh=np.zeros(5); tot_tok=np.zeros(4); tot_tokc=np.zeros((5,4)); last=base
    for c,kk in chunks.items():
        sh=np.zeros(5); tk=np.zeros(4); tkc=np.zeros((5,4))
        for k in kk:
            d=buckets[k]
            for f,ss in d['scls'].items(): sh[f]+=len(ss)*B/3600
            tk+=d['tok']; tkc+=d['tokc']
        e=buckets[kk[-1]]['env']; dy=e-last; last=e
        X_s.append(sh); X_t.append(np.concatenate([tk,tkc[:, [1,2,3]].ravel()])); Y.append(dy); CH.append((o,wid))
        tot_sh+=sh; tot_tok+=tk; tot_tokc+=tkc
    dU=last-base
    per_win.append(dict(org=o,wid=wid,span_h=span_h,dU=dU,sh=tot_sh,tok=tot_tok,tokc=tot_tokc,start=ks[0][1]*B,base=base))
X_s=np.array(X_s); X_t=np.array(X_t); Y=np.array(Y); CHo=np.array([c[0] for c in CH])
# per-window K (all classes pooled): require >=0.5 session-hours and dU>=0.03 measured
Kw=[]; Kw_meta=[]
for w in per_win:
    shs=w['sh'].sum()
    if shs>=1.0 and w['span_h']>=1.0 and w['dU']>=0.02:
        Kw.append(w['dU']/shs); Kw_meta.append(w)
R['K_pooled_per_window']=dict(n=len(Kw),p10_50_90=q(Kw), n_windows_total=len(per_win))
R['K_pooled_per_window_by_org']={ORGS[o][:8]:dict(n=int(sum(1 for w in Kw_meta if w['org']==o)),p10_50_90=q([k for k,w in zip(Kw,Kw_meta) if w['org']==o])) for o in range(4)}
# windows that hit the ceiling (env>=0.98) are censored -> report separately
Kw_unc=[k for k,w in zip(Kw,Kw_meta) if w['base']+w['dU']<0.95]
R['K_pooled_uncensored']=dict(n=len(Kw_unc),p10_50_90=q(Kw_unc))
# multi-regression per class on hourly chunks (NNLS, with intercept column for unexplained drift)
def fit(X,y,names,intercept=True):
    Xm=np.column_stack([X,np.ones(len(X))]) if intercept else X
    coef,_=nnls(Xm,y); pred=Xm@coef; ss=((y-y.mean())**2).sum(); r2=1-((y-pred)**2).sum()/ss if ss>0 else None
    return dict(zip(names+(['intercept_per_hour'] if intercept else []),[float(c) for c in coef])),r2
keep=X_s.sum(1)>0
cls_names=CLS[:4]
coef,r2=fit(X_s[keep][:,:4],Y[keep],cls_names)
# bootstrap over windows for CI
rng=np.random.default_rng(7); wids=np.array([c[1] for c in CH])[keep]; uw=np.unique(wids)
idx_by_w={w:np.where(wids==w)[0] for w in uw}; Xk=X_s[keep][:,:4]; Yk=Y[keep]; boots=[]
for _ in range(200):
    sel=np.concatenate([idx_by_w[w] for w in rng.choice(uw,len(uw))])
    c,_=nnls(np.column_stack([Xk[sel],np.ones(len(sel))]),Yk[sel]); boots.append(c)
boots=np.array(boots)
R['K_by_class_regression']=dict(n_chunks=int(keep.sum()),n_windows=len(uw),r2=r2,
   coef={k:dict(K=v,p10=float(np.percentile(boots[:,i],10)),p90=float(np.percentile(boots[:,i],90))) for i,(k,v) in enumerate(coef.items())},
   session_hours_by_class={CLS[f]:float(Xk[:,f].sum()) for f in range(4)},
   chunks_with_class={CLS[f]:int((Xk[:,f]>0).sum()) for f in range(4)})
# per-window K for single-dominant-class windows (>=90% of session-hours one class), main classes
Kc=collections.defaultdict(list)
for w in Kw_meta:
    sh=w['sh'][:4]; f=int(np.argmax(sh))
    if sh[f]>=0.9*sh.sum(): Kc[CLS[f]].append(w['dU']/sh.sum())
R['K_per_window_dominant_class']={c:dict(n=len(v),p10_50_90=q(v)) for c,v in Kc.items()}
# tokens: hourly NNLS on [cacheWrite, output, cacheRead, input]
Xt=X_t[:,[3,1,2,0]]
coef_t,r2t=fit(Xt[keep],Y[keep],['cacheWrite','output','cacheRead','input'])
boots=[]
for _ in range(200):
    sel=np.concatenate([idx_by_w[w] for w in rng.choice(uw,len(uw))])
    c,_=nnls(np.column_stack([Xt[keep][sel],np.ones(len(sel))]),Yk[sel]); boots.append(c)
boots=np.array(boots)
def per_point(c): return 0.01/c if c>0 else None
R['tokens_regression']=dict(r2=r2t,coef={k:v for k,v in coef_t.items()},
   tokens_per_point={k:per_point(v) for k,v in coef_t.items() if k!='intercept_per_hour'},
   tokens_per_point_p10_p90={k:[per_point(np.percentile(boots[:,i],90)),per_point(np.percentile(boots[:,i],10))] for i,k in enumerate(['cacheWrite','output','cacheRead','input'])})
# fixed-prior check: with read=44M/pt, solve write & output only
# per-window: cost-equivalent tokens ratio  (cw-equivalent incl. read at prior 494k/44M)
cwe=[]; 
for w in Kw_meta:
    t=w['tok']; eq=t[3]+t[2]*494e3/44e6
    cwe.append(eq/(w['dU']*100))
R['per_window_cw_equiv_tokens_per_point']=dict(n=len(cwe),p10_50_90=q(cwe))
# per-family token regression (opus / fable / sonnet  cw,out,cr)
fam_tok_cols=[]
Xf=[]
for x in X_t:  # x: tk(4) + tkc[:,1:4] -> ravel of 5 fams x 3 (out,cr,cw)
    m=x[4:].reshape(5,3)  # cols out,cr,cw
    Xf.append(np.concatenate([[m[f,2],m[f,0],m[f,1]] for f in (0,3,1,2)]))
Xf=np.array(Xf); names=[f'{fn}:{t}' for fn in ('opus','fable','sonnet','haiku') for t in ('cacheWrite','output','cacheRead')]
cf,r2f=fit(Xf[keep],Y[keep],names)
R['tokens_regression_by_family']=dict(r2=r2f,tokens_per_point={k:per_point(v) for k,v in cf.items() if k!='intercept_per_hour'},
   token_totals={n:float(Xf[keep][:,i].sum()) for i,n in enumerate(names)})
# ---------- 3. session dynamics
S_=list(sess_first)
life=np.array([(sess_last[s]-sess_first[s])/3600 for s in S_]); nt=np.array([sess_turns[s] for s in S_])
cls=np.array([sess_cls[s] for s in S_]); actb=np.array([len(sess_buckets[s]) for s in S_])
def dist(m): return dict(n=int(m.sum()),lifetime_h_p10_50_90=q(life[m]),lifetime_h_p75_p95=q(life[m],(75,95)),
     active_hours_p10_50_90=q(actb[m]*B/3600), turns_p10_50_90=q(nt[m]),
     turns_per_active_hour_p10_50_90=q(nt[m]/(actb[m]*B/3600)))
R['sessions']={'all':dist(np.ones(len(S_),bool))}
for f in range(4): R['sessions'][CLS[f]]=dist(cls==f)
main=(cls!=2)&(nt>=5); R['sessions']['main(non-haiku,>=5 turns)']=dist(main)
# inertia: time from first turn until 50/90% of the session's cost (cw-equiv tokens) consumed
cost=collections.defaultdict(list)
w_cw=1.0; w_cr=494e3/44e6
for i in range(len(a)):
    cost[ses[i]].append((a[i,T],a[i,CW]+a[i,CR]*w_cr+a[i,OUT]*0))
t50=[];t90=[];tend=[]
for s in S_:
    if not main[S_.index(s)] if False else False: pass
mi=set(np.array(S_)[main])
for s in mi:
    v=np.array(cost[s]); c=np.cumsum(v[:,1]); 
    if c[-1]<=0: continue
    t0=v[0,0]; t50.append((v[np.searchsorted(c,0.5*c[-1]),0]-t0)/3600); t90.append((v[np.searchsorted(c,0.9*c[-1]),0]-t0)/3600)
R['inertia_main']=dict(n=len(t50),t50_h_p10_50_90=q(t50),t90_h_p10_50_90=q(t90))
# arrivals per hour (per org and total, main and all) — only over hours where the org had any traffic that day
for lbl,mask in (('all',np.ones(len(S_),bool)),('main',main)):
    st=np.array([sess_first[s] for s in np.array(S_)[mask]]); so=np.array([sess_org[s] for s in np.array(S_)[mask]])
    hrs=np.floor(st/3600).astype(np.int64)
    # total fleet: hours between first and last observed hour where fleet had any turn
    act_h=np.unique(np.floor(a[:,T]/3600).astype(np.int64))
    cnt=collections.Counter(hrs); arr=np.array([cnt.get(h,0) for h in act_h])
    R[f'arrivals_per_hour_fleet_{lbl}']=dict(n_hours=len(act_h),mean=float(arr.mean()),p10_50_90=q(arr),p95_p99=q(arr,(95,99)),max=int(arr.max()))
    per={}
    for o in range(4):
        ah=np.unique(np.floor(a[org==o,T]/3600).astype(np.int64)); c=collections.Counter(hrs[so==o]); x=np.array([c.get(h,0) for h in ah])
        per[ORGS[o][:8]]=dict(n_hours=len(ah),mean=float(x.mean()),p50_90_99=q(x,(50,90,99)))
    R[f'arrivals_per_hour_by_org_{lbl}']=per
# concurrency: active sessions per 5-min bucket per org
conc={}
for o in range(4):
    x=np.array([len(buckets[k]['ses']) for k in series[o]]); xm=np.array([sum(len(v) for f,v in buckets[k]['scls'].items() if f!=2) for k in series[o]])
    conc[ORGS[o][:8]]=dict(n_buckets=len(x),all_p50_90_99=q(x,(50,90,99)),nonhaiku_p50_90_99=q(xm,(50,90,99)))
R['active_sessions_per_bucket']=conc
# ---------- 4. lag
# (a) turn-level: in periods where only ONE session is active on an org, a big cacheWrite turn (>=200k)
# -> time & turns until envelope rises by >=0.01 above the util reported AT that turn
lagA=[];lagA_same=0;lagA_n=0
idx_by_org={o:np.where(org==o)[0] for o in range(4)}
for o in range(4):
    ii=idx_by_org[o]; tt=a[ii,T]; uu=a[ii,U5]; ss=ses[ii]; cw=a[ii,CW]
    for j in np.where(cw>=200e3)[0]:
        if j==0 or j+1>=len(ii): continue
        # isolation: no other session in +-10 min
        lo=np.searchsorted(tt,tt[j]-600); hi=np.searchsorted(tt,tt[j]+600)
        if np.any(ss[lo:hi]!=ss[j]): continue
        prev=np.nanmax(uu[lo:j]) if j>lo else uu[j-1]
        lagA_n+=1
        if uu[j]>=prev+0.01: lagA_same+=1; lagA.append(0.0); continue
        for m in range(j+1,hi):
            if uu[m]>=prev+0.01: lagA.append(tt[m]-tt[j]); break
R['lag_turn_level']=dict(n_events=lagA_n,already_in_same_response=lagA_same,n_resolved=len(lagA),lag_s_p10_50_90=q(lagA))
# (b) session-start event study: new main session on an org with no other active session in prior 30 min
evs=[]
for s in mi:
    o=sess_org[s]; t0=sess_first[s]; ii=idx_by_org[o]; tt=a[ii,T]
    lo=np.searchsorted(tt,t0-1800); hi=np.searchsorted(tt,t0+3*3600)
    pre=ses[ii][lo:np.searchsorted(tt,t0)]
    if len(pre) and np.any(pre!=s): continue
    seg=ii[np.searchsorted(tt,t0):hi]
    u0=a[seg[0],U5]
    if np.isnan(u0) or u0>0.9: continue
    # stop if another session appears before rise
    lag=None; tok=0
    for m in seg:
        if ses[m]!=s: break
        tok+=a[m,CW]+a[m,CR]*w_cr
        if a[m,U5]>=u0+0.01: lag=(a[m,T]-t0,tok); break
    evs.append(lag)
res=[e for e in evs if e]
R['lag_session_start_isolated']=dict(n_sessions=len(evs),n_rose_before_other_session=len(res),
   lag_min_p10_50_90=q([e[0]/60 for e in res]),cw_equiv_tokens_until_rise_p10_50_90=q([e[1] for e in res]))
# ---------- 5. replay dataset
out='/home/relishev/projects/vibe/claude-code-sdk/research/placement-pid-history.jsonl.gz'
n=0
def r6(x): return None if (x is None or (isinstance(x,float) and np.isnan(x))) else round(float(x),4)
with gzip.open(out,'wt',compresslevel=9) as g:
    for o in range(4):
        for k in series[o]:
            d=buckets[k]
            rec=dict(org=ORGS[o],t=int(k[1]*B),ts=datetime.fromtimestamp(k[1]*B,timezone.utc).strftime('%Y-%m-%dT%H:%MZ'),
                util5h=r6(d['u5']),util5h_max=r6(d['u5max']),util5h_env=r6(d['env']),util7d=r6(d['u7']),
                resetAt=None if np.isnan(d['r5']) else int(d['r5']),window=d['wid'],reset=d['reset'],turns=d['n'],
                active_sessions=len(d['ses']),new_sessions=len(d['new']),
                sessions_by_class={CLS[f]:len(v) for f,v in sorted(d['scls'].items())},
                new_by_class=dict(collections.Counter(CLS[sess_cls[s]] for s in d['new'])),
                tokens=dict(zip(('in','out','cacheRead','cacheWrite'),map(int,d['tok']))),
                tokens_by_class={CLS[f]:dict(zip(('in','out','cacheRead','cacheWrite'),map(int,d['tokc'][f]))) for f in range(5) if d['tokc'][f].any()})
            g.write(json.dumps(rec,separators=(',',':'))+'\n'); n+=1
R['replay']=dict(path=out,lines=n)
R['coverage']={ORGS[o][:8]:dict(turns=int((org==o).sum()),first=datetime.fromtimestamp(a[org==o,T].min(),timezone.utc).isoformat()[:16],
   last=datetime.fromtimestamp(a[org==o,T].max(),timezone.utc).isoformat()[:16],buckets=len(series[o]),sessions=len({s for s in S_ if sess_org[s]==o})) for o in range(4)}
R['skipped']=json.loads(str(z['skipped']))
json.dump(R,open('/home/relishev/projects/vibe/claude-code-sdk/research/placement-pid-scripts/results.json','w'),indent=1,default=float)
print(json.dumps(R,indent=1,default=float))
