const express=require('express'),http=require('http'),path=require('path');
const {Server}=require('socket.io');
const app=express(),srv=http.createServer(app),io=new Server(srv,{cors:{origin:'*'}});
app.get('/',(q,r)=>r.sendFile(path.join(__dirname,'index.html')));
app.get('/health',(q,r)=>r.send('ok'));
// Трасса: те же формулы, что и в index.html
const N=16,TAU=Math.PI*2,CPR=35,MAXV=85,NCARS=3;
const P=t=>({x:380*Math.cos(t)+70*Math.cos(3*t),z:240*Math.sin(t)+50*Math.sin(2*t)});
const CP=[];for(let i=0;i<N;i++)CP.push(P(i/N*TAU));
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const rooms=new Map();
function mkCode(){const A='ABCDEFGHJKLMNPQRSTUVWXYZ';let c;do{c='';for(let i=0;i<4;i++)c+=A[Math.random()*A.length|0]}while(rooms.has(c));return c}
const pub=r=>({code:r.code,laps:r.laps,st:r.st,pl:r.pl.map((p,i)=>({id:p.s.id,car:p.car,ready:p.ready,host:i===0}))});
const push=r=>io.to(r.code).emit('room',pub(r));
function endRace(r,win,reason){
  if(r.st!=='run'&&r.st!=='count')return;
  clearTimeout(r.timer);r.st='lobby';
  const times={};r.pl.forEach(p=>{if(p.fin)times[p.s.id]=p.fin;p.ready=false});
  io.to(r.code).emit('end',{winner:win,reason,times});push(r);
}
function detach(s){
  const r=rooms.get(s.data.room);if(!r)return;
  s.leave(r.code);s.data.room=null;
  const i=r.pl.findIndex(p=>p.s===s);if(i<0)return;
  r.pl.splice(i,1);
  if(r.st!=='lobby'&&r.pl[0])endRace(r,r.pl[0].s.id,'left');
  r.st='lobby';r.pl.forEach(p=>p.ready=false);
  if(!r.pl.length){clearTimeout(r.timer);rooms.delete(r.code)}else push(r);
}
function attach(s,r){
  s.join(r.code);s.data.room=r.code;
  r.pl.push({s,car:0,ready:false,pr:0,fin:0,x:0,z:0,h:0,v:0,last:Date.now()});push(r);
}
io.on('connection',s=>{
  s.on('create',cb=>{detach(s);const code=mkCode();const r={code,laps:3,st:'lobby',pl:[],t0:0};rooms.set(code,r);attach(s,r);cb&&cb({ok:1,code})});
  s.on('join',(c,cb)=>{
    detach(s);const r=rooms.get(String(c||'').toUpperCase().trim());
    if(!r)return cb&&cb({err:'Комната не найдена'});
    if(r.pl.length>=2)return cb&&cb({err:'Комната заполнена'});
    if(r.st!=='lobby')return cb&&cb({err:'Гонка уже идёт'});
    attach(s,r);cb&&cb({ok:1,code:r.code});
  });
  s.on('leave',()=>detach(s));
  s.on('disconnect',()=>detach(s));
  s.on('setup',o=>{const r=rooms.get(s.data.room);if(!r||r.st!=='lobby'||r.pl[0].s!==s)return;r.laps=clamp((o&&o.laps)|0,1,5);r.pl.forEach(p=>p.ready=false);push(r)});
  s.on('car',i=>{const r=rooms.get(s.data.room);if(!r||r.st!=='lobby')return;const p=r.pl.find(q=>q.s===s);if(p){p.car=clamp(i|0,0,NCARS-1);push(r)}});
  s.on('ready',v=>{
    const r=rooms.get(s.data.room);if(!r||r.st!=='lobby')return;
    const p=r.pl.find(q=>q.s===s);if(!p)return;p.ready=!!v;push(r);
    if(r.pl.length===2&&r.pl.every(q=>q.ready)){
      r.st='count';r.t0=Date.now()+4000;
      r.pl.forEach((q,i)=>{q.pr=0;q.fin=0;q.x=445+i*10;q.z=-4-i*8;q.h=0;q.v=0;q.last=Date.now();q.s.emit('go',{ms:4000,laps:r.laps,sx:q.x,sz:q.z})});
      setTimeout(()=>{if(r.st==='count')r.st='run'},4000);
      r.timer=setTimeout(()=>{if(r.st==='run'){const a=r.pl.slice().sort((x,y)=>y.pr-x.pr)[0];endRace(r,a&&a.s.id,'timeout')}},15*60*1000);
    }
  });
  // позиция клиента: сервер проверяет скорость, сам считает контрольные точки и финиш
  s.on('st',d=>{
    const r=rooms.get(s.data.room);if(!r||!d||(r.st!=='run'&&r.st!=='count'))return;
    const p=r.pl.find(q=>q.s===s);if(!p||p.fin)return;
    const x=+d.x,z=+d.z,h=+d.h,v=+d.v;if(![x,z,h,v].every(Number.isFinite))return;
    const now=Date.now(),dt=Math.min(1,(now-p.last)/1000);p.last=now;
    if(Math.hypot(x-p.x,z-p.z)>MAXV*dt+8){s.emit('fix',{x:p.x,z:p.z});return}
    p.x=x;p.z=z;p.h=h;p.v=clamp(v,-80,100);
    if(r.st==='run'&&now>=r.t0){
      const n=CP[(p.pr+1)%N];
      if(Math.hypot(x-n.x,z-n.z)<CPR){
        p.pr++;s.emit('me',{pr:p.pr});
        if(p.pr>=r.laps*N){p.fin=now-r.t0;endRace(r,s.id,'finish')}
      }
    }
    const o=r.pl.find(q=>q!==p);
    if(o)o.s.emit('opp',{x,z,h,v:p.v,pr:p.pr});
  });
});
const PORT=process.env.PORT||3000;
srv.listen(PORT,()=>console.log('Apex Duel: http://localhost:'+PORT));
