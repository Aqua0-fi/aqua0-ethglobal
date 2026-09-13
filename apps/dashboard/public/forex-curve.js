(() => {
  const $ = id => document.getElementById(id);
  const svg = $('chart');
  let direction = 'toBRL';
  const P_FIXED = {delta:.5, maxf:.25, lam:.3, eps:.003};
  const confBps = 0;
  const NS='http://www.w3.org/2000/svg';
  const fmt=n=>new Intl.NumberFormat('en-US',{maximumFractionDigits:2}).format(n);
  const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));

  class Revert extends Error {}
  function micro(b,I,P){
    if(b<I){const m=I*(1-P.beta)-b;if(m>0)return Math.min(m*P.delta/I,P.maxf)*m;}
    else {const m=b-I*(1+P.beta);if(m>0)return Math.min(m*P.delta/I,P.maxf)*m;}
    return 0;
  }
  function psi(x,y,P){const I=(x+y)/2;return micro(x,I,P)+micro(y,I,P)}
  const REGS=['in','below-quad','below-cap','above-quad','above-cap'];
  function piece(b0,kbal,g,side,P){return side==='below' ? [(1-P.beta)*g/2-b0,(1-P.beta)/2-kbal] : [b0-(1+P.beta)*g/2,kbal-(1+P.beta)/2]}
  function regimeCoeffs(m0,k,reg,g,P){
    if(reg==='in')return [0,0,0];
    if(reg.endsWith('quad')){const d2=2*P.delta;return [d2*k*k,d2*2*m0*k,d2*m0*m0]}
    const M=P.maxf;return [M*k,M*(m0+k*g),M*m0*g];
  }
  function checkRegime(b,I,reg,P){
    if(reg==='in')return I*(1-P.beta)-1e-9<=b && b<=I*(1+P.beta)+1e-9;
    const [side,kind]=reg.split('-');
    const m=side==='below' ? I*(1-P.beta)-b : b-I*(1+P.beta);
    if(m<=-1e-9)return false;
    const capped=m*P.delta/I>=P.maxf-1e-12;
    return capped===(kind==='cap');
  }
  function tradeClosed(x,y,i,a,P){
    const g=x+y, omega=psi(x,y,P);
    const nx0=i===0?x+a:x-a, ny0=i===0?y-a:y+a;
    if(omega===0 && nx0>0 && ny0>0 && psi(nx0,ny0,P)===0)return -a;
    const parts=[null,null];
    parts[i]=[(i===0?x:y)+a,0];
    parts[1-i]=[(i===0?y:x)-a,1];
    let best=null;
    for(const c of [1,P.lam]) for(const rx of REGS) for(const ry of REGS){
      let A=1,B=g+c*omega,C=c*omega*g;
      for(const [part,reg] of [[parts[0],rx],[parts[1],ry]]){
        if(reg==='in')continue;
        const [m0,k]=piece(part[0],part[1],g,reg.split('-')[0],P);
        const [a2,b2,c2]=regimeCoeffs(m0,k,reg,g,P);
        A-=c*a2;B-=c*b2;C-=c*c2;
      }
      const disc=B*B-4*A*C;if(disc<0)continue;
      const r=Math.sqrt(disc);let roots=[];
      if(Math.abs(A)<1e-16){if(Math.abs(B)>1e-16)roots=[-C/B];}
      else {const r1=B>=0?(-B-r)/(2*A):(-B+r)/(2*A);roots=r1!==0?[r1,C/(A*r1)]:[r1,-B/A];}
      for(const s of roots){
        if(!(s>-g) || !Number.isFinite(s))continue;
        const nx=parts[0][0]+parts[0][1]*s, ny=parts[1][0]+parts[1][1]*s;if(nx<=0||ny<=0)continue;
        const I=(g+s)/2;if(!checkRegime(nx,I,rx,P)||!checkRegime(ny,I,ry,P))continue;
        const ps=psi(nx,ny,P), cc=omega<ps?1:P.lam;
        if(cc!==c && Math.abs(ps-omega)>1e-12*Math.max(1,omega))continue;
        const res=Math.abs(s-c*(ps-omega));if(!best||res<best[0])best=[res,s];
      }
    }
    if(!best)throw new Revert('no consistent piece');
    return best[1]-a;
  }
  function enforceHalts(x,y,nx,ny,P){
    const oI=(x+y)/2,nI=(nx+ny)/2,al=P.alpha;
    for(const [ob,nb] of [[x,nx],[y,ny]]){
      if(nb>nI){const nH=nI*(1+al);if(nb>nH){const oH=oI*(1+al);if(ob<oH||nb-nH>ob-oH+1e-8)throw new Revert('halt');}}
      else {const nH=nI*(1-al);if(nb<nH){const oH=oI*(1-al);if(ob>oH||nH-nb>oH-ob+1e-8)throw new Revert('halt');}}
    }
  }
  function quote(p,U,B,amount,toBRL,P,includeFee=true){
    const x=U,y=p*B;
    const eps=includeFee ? P.eps+confBps/10000 : 0;
    if(U<=0||B<=0||amount<0)throw new Revert('bad balance');
    if(toBRL){
      const o=tradeClosed(x,y,0,amount,P);const nx=x+amount,ny=y+o;enforceHalts(x,y,nx,ny,P);
      return {out:-o*(1-eps)/p,nx,ny};
    } else {
      const a=p*amount;const o=tradeClosed(x,y,1,a,P);const nx=x+o,ny=y+a;enforceHalts(x,y,nx,ny,P);
      return {out:-o*(1-eps),nx,ny};
    }
  }

  function el(name,attrs={}){const e=document.createElementNS(NS,name);for(const [k,v] of Object.entries(attrs))e.setAttribute(k,v);return e}
  function line(x1,y1,x2,y2,stroke,width=1,dash=''){const e=el('line',{x1,y1,x2,y2,stroke,'stroke-width':width});if(dash)e.setAttribute('stroke-dasharray',dash);svg.appendChild(e);return e}
  function text(x,y,s,fill='#8b97a4',size=12,anchor='start',weight=500){const e=el('text',{x,y,fill,'font-size':size,'text-anchor':anchor,'font-weight':weight,'font-family':'Inter,ui-sans-serif,-apple-system,sans-serif'});e.textContent=s;svg.appendChild(e);return e}

  function state(){
    const q=+$('q').value, p=1/q, U=+$('u').value, B=+$('b').value, amount=+$('amt').value;
    const P={...P_FIXED,beta:+$('beta').value,alpha:+$('alpha').value};
    const x=U,y=p*B,I=(x+y)/2,z=(x-I)/I;
    return {q,p,U,B,amount,P,x,y,I,z};
  }

  function curvePoint(z,g,p,P){
    const I=g/2,x=I*(1+z),y=I*(1-z),B=y/p;
    const probe=Math.max(.01,g*1e-5);
    try{
      const r=quote(p,x,B,probe,true,{...P,eps:0},false);
      const effectiveP=probe/r.out;
      return (effectiveP/p-1)*10000;
    }catch{return null}
  }

  function renderChart(s,preview=null){
    while(svg.firstChild)svg.removeChild(svg.firstChild);
    const defs=el('defs');
    const arrow=el('marker',{id:'tradeArrow',viewBox:'0 0 10 10',refX:8,refY:5,markerWidth:7,markerHeight:7,orient:'auto-start-reverse'});
    arrow.appendChild(el('path',{d:'M 0 0 L 10 5 L 0 10 z',fill:'#f6c760'}));
    const haltArrow=el('marker',{id:'haltArrow',viewBox:'0 0 10 10',refX:8,refY:5,markerWidth:7,markerHeight:7,orient:'auto-start-reverse'});
    haltArrow.appendChild(el('path',{d:'M 0 0 L 10 5 L 0 10 z',fill:'#ff6666'}));
    defs.appendChild(arrow);defs.appendChild(haltArrow);svg.appendChild(defs);
    const W=1000,H=560,m={l:72,r:30,t:34,b:62},pw=W-m.l-m.r,ph=H-m.t-m.b;
    const xmin=-.62,xmax=.62;
    const samples=[];const g=s.x+s.y;
    for(let i=0;i<=260;i++){const z=xmin+(xmax-xmin)*i/260; samples.push([z,curvePoint(z,g,s.p,s.P)]);}
    const vals=samples.map(d=>d[1]).filter(v=>v!==null&&Number.isFinite(v));
    const abs=Math.max(70,Math.min(450,Math.max(...vals.map(v=>Math.abs(v)),70)*1.18));
    const ymin=-abs,ymax=abs;
    const X=z=>m.l+(z-xmin)/(xmax-xmin)*pw, Y=v=>m.t+(ymax-v)/(ymax-ymin)*ph;

    // bands
    const leftHalt=el('rect',{x:X(xmin),y:m.t,width:Math.max(0,X(-s.P.alpha)-X(xmin)),height:ph,fill:'rgba(255,80,80,.07)'});svg.appendChild(leftHalt);
    const rightHalt=el('rect',{x:X(s.P.alpha),y:m.t,width:Math.max(0,X(xmax)-X(s.P.alpha)),height:ph,fill:'rgba(255,80,80,.07)'});svg.appendChild(rightHalt);
    const band=el('rect',{x:X(-s.P.beta),y:m.t,width:X(s.P.beta)-X(-s.P.beta),height:ph,fill:'rgba(85,231,154,.055)'});svg.appendChild(band);

    for(let z=-.6;z<=.6001;z+=.2){line(X(z),m.t,X(z),m.t+ph,'#1a232c');text(X(z),m.t+ph+24,z.toFixed(1),'#66727e',11,'middle')}
    for(let k=-2;k<=2;k++){const v=k*abs/2;line(m.l,Y(v),m.l+pw,Y(v),'#1a232c');text(m.l-12,Y(v)+4,Math.round(v)+' bps','#66727e',11,'end')}
    line(m.l,Y(0),m.l+pw,Y(0),'#46525f',1,'4 5');
    for(const [z,c,label] of [[-s.P.alpha,'#ff6666','−α'],[s.P.alpha,'#ff6666','+α'],[-s.P.beta,'#55e79a','−β'],[s.P.beta,'#55e79a','+β']]){line(X(z),m.t,X(z),m.t+ph,c,1.4,'5 5');text(X(z),m.t+16,label,c,11,'middle',700)}
    text(X(0),m.t+22,'oracle band','#55e79a',12,'middle',700);
    text((X(-s.P.alpha)+X(-s.P.beta))/2,m.t+22,'penalty','#f6c760',11,'middle',600);
    text((X(s.P.alpha)+X(s.P.beta))/2,m.t+22,'penalty','#f6c760',11,'middle',600);
    text((X(xmin)+X(-s.P.alpha))/2,m.t+22,'halt','#ff6666',11,'middle',700);
    text((X(xmax)+X(s.P.alpha))/2,m.t+22,'halt','#ff6666',11,'middle',700);

    let d='',open=false;
    for(const [z,v] of samples){if(v===null||!Number.isFinite(v)||Math.abs(v)>abs*1.2){open=false;continue}const cmd=(open?'L':'M')+X(z).toFixed(2)+' '+Y(clamp(v,ymin,ymax)).toFixed(2);d+=cmd+' ';open=true}
    const path=el('path',{d,fill:'none',stroke:'#56e1ff','stroke-width':3,'stroke-linecap':'round','stroke-linejoin':'round'});path.style.filter='drop-shadow(0 0 6px rgba(86,225,255,.28))';svg.appendChild(path);

    const currentV=curvePoint(clamp(s.z,xmin,xmax),g,s.p,s.P);
    let currentPx=null,currentPy=null;
    if(currentV!==null&&s.z>=xmin&&s.z<=xmax){
      currentPx=X(s.z);currentPy=Y(clamp(currentV,ymin,ymax));
      line(currentPx,m.t,currentPx,m.t+ph,'rgba(255,255,255,.28)',1,'3 5');
      const c=el('circle',{cx:currentPx,cy:currentPy,r:7,fill:'#080a0c',stroke:'#fff','stroke-width':2.5});svg.appendChild(c);
      text(currentPx,currentPy-16,'current pool','#f4f7fa',11,'middle',650);
    }

    if(preview&&currentPx!==null&&currentPy!==null&&Number.isFinite(preview.z1)){
      const endZ=clamp(preview.z1,xmin,xmax);
      const endV=preview.halted ? curvePoint(clamp(endZ,xmin,xmax),g,s.p,s.P) : preview.v1;
      if(endV!==null&&Number.isFinite(endV)){
        const endPx=X(endZ),endPy=Y(clamp(endV,ymin,ymax));
        const color=preview.halted?'#ff6666':'#f6c760';
        const seg=el('line',{x1:currentPx,y1:currentPy,x2:endPx,y2:endPy,stroke:color,'stroke-width':4,'stroke-linecap':'round','marker-end':preview.halted?'url(#haltArrow)':'url(#tradeArrow)'});
        seg.style.filter=preview.halted?'drop-shadow(0 0 6px rgba(255,102,102,.38))':'drop-shadow(0 0 6px rgba(246,199,96,.36))';svg.appendChild(seg);
        const dot=el('circle',{cx:endPx,cy:endPy,r:7,fill:color,stroke:'#080a0c','stroke-width':2.5});svg.appendChild(dot);
        dot.style.filter=preview.halted?'drop-shadow(0 0 7px rgba(255,102,102,.42))':'drop-shadow(0 0 7px rgba(246,199,96,.42))';
        const dx=Math.abs(endPx-currentPx),labelX=(currentPx+endPx)/2,labelY=Math.min(currentPy,endPy)-16;
        if(dx>38) text(labelX,labelY,preview.halted?'trade hits α halt':`after ${fmt(preview.amount)} ${preview.inputToken}`,color,11,'middle',700);
      }
    }
    text(m.l+pw/2,H-17,'normalized USDC imbalance  (x − I) / I','#798693',11,'middle');
  }

  function render(){
    const s=state();
    $('qVal').textContent=s.q.toFixed(2);
    $('uVal').textContent=fmt(s.U)+' USDC';
    $('bVal').textContent=fmt(s.B)+' BRL';
    $('amtVal').textContent=fmt(s.amount)+' '+(direction==='toBRL'?'USDC':'BRL');
    $('betaVal').textContent=s.P.beta.toFixed(2);
    $('alphaVal').textContent=s.P.alpha.toFixed(2);
    let preview=null;

    const zone=Math.abs(s.z)>s.P.alpha?'halt':Math.abs(s.z)>s.P.beta?'penalty':'oracle band';
    $('inventoryText').textContent=(s.z>=0?'+':'')+(s.z*100).toFixed(1)+'% · '+zone;
    $('inventoryText').className='v small '+(zone==='halt'?'bad':zone==='penalty'?'warn':'good');
    try{
      const toBRL=direction==='toBRL';
      const r=quote(s.p,s.U,s.B,s.amount,toBRL,s.P,true);
      const curveOnly=quote(s.p,s.U,s.B,s.amount,toBRL,{...s.P,eps:0},false);
      const postI=(curveOnly.nx+curveOnly.ny)/2;
      const postZ=(curveOnly.nx-postI)/postI;
      preview={
        z1:postZ,
        v1:curvePoint(postZ,curveOnly.nx+curveOnly.ny,s.p,s.P),
        halted:false,
        amount:s.amount,
        inputToken:toBRL?'USDC':'BRL'
      };
      const oracleOut=toBRL?s.amount*s.q:s.amount*s.p;
      const curveSpread=(1-curveOnly.out/oracleOut)*10000;
      const feeContribution=s.P.eps*10000;
      const displayedSpread=curveSpread+feeContribution;
      $('quoteText').textContent=toBRL ? `${fmt(s.amount)} USDC → ${fmt(r.out)} BRL` : `${fmt(s.amount)} BRL → ${fmt(r.out)} USDC`;
      $('feeText').textContent=feeContribution.toFixed(1)+' bps';
      $('curveText').textContent=(curveSpread>=0?'+':'')+curveSpread.toFixed(1)+' bps';
      $('spreadText').textContent=(displayedSpread>=0?'+':'')+displayedSpread.toFixed(1)+' bps';
      $('spreadText').className='num '+(displayedSpread<60?'good':displayedSpread<150?'warn':'bad');
      $('statusText').textContent='trade allowed';$('statusText').className='v small good';
    }catch(e){
      $('quoteText').textContent='—';$('feeText').textContent='—';$('curveText').textContent='—';$('spreadText').textContent='—';$('spreadText').className='num';
      $('statusText').textContent=e.message==='halt'?'halted by α':'quote unavailable';$('statusText').className='v small bad';
      if(e.message==='halt'){
        const sign=direction==='toBRL'?1:-1;
        const haltZ=sign*(s.P.alpha-.004);
        preview={z1:haltZ,v1:curvePoint(haltZ,s.x+s.y,s.p,s.P),halted:true,amount:s.amount,inputToken:direction==='toBRL'?'USDC':'BRL'};
      }
    }
    renderChart(s,preview);
  }

  ['q','u','b','amt','beta','alpha'].forEach(id=>$(id).addEventListener('input',render));
  $('toBrl').onclick=()=>{direction='toBRL';$('toBrl').classList.add('active');$('toUsdc').classList.remove('active');render()};
  $('toUsdc').onclick=()=>{direction='toUSDC';$('toUsdc').classList.add('active');$('toBrl').classList.remove('active');render()};
  $('reset').onclick=()=>{$('q').value=5.42;$('u').value=5000;$('b').value=27100;$('amt').value=100;$('beta').value=.15;$('alpha').value=.5;direction='toBRL';$('toBrl').classList.add('active');$('toUsdc').classList.remove('active');render()};
  render();
})();
