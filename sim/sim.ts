import * as fs from "node:fs";
import * as smart from "../src/strategy.js";
// Standalone repo: ../wordlist.txt. Monorepo: ../../spacetimedb/wordlist.txt.
const dictURL=["../wordlist.txt","../../spacetimedb/wordlist.txt"].map(p=>new URL(p,import.meta.url)).find(u=>fs.existsSync(u))!;
const dict = fs.readFileSync(dictURL,"utf8").split("\n").map(l=>l.trim().toUpperCase()).filter(Boolean).sort((a,b)=>b.length-a.length);
const BAG:[string,number][]=[["A",9],["B",2],["C",2],["D",4],["E",12],["F",2],["G",3],["H",2],["I",9],["J",1],["K",1],["L",4],["M",2],["N",6],["O",8],["P",2],["Q",1],["R",6],["S",4],["T",6],["U",4],["V",2],["W",2],["X",1],["Y",2],["Z",1]];
const can=(w:string,r:Map<string,number>)=>{const u:Record<string,number>={};for(const c of w){u[c]=(u[c]??0)+1;if(u[c]>(r.get(c)??0))return false}return true};
// Opponents bid like the live market: letter value + 6..14, capped at balance.
const dflt={bid(L:string,bal:number,_r:Map<string,number>){const v=smart.LETTER_VALUE[L]??1;return Math.min(v+6+Math.floor(Math.random()*9),bal)},
 word(r:Map<string,number>){let t=0;for(const n of r.values())t+=n;for(const w of dict)if(w.length<=t&&can(w,r))return w;return null}};
function game(fp:boolean){
 const bag:string[]=[];for(const[l,n]of BAG)for(let i=0;i<n;i++)bag.push(l);
 const draw=()=>bag.splice(Math.floor(Math.random()*bag.length),1)[0];
 const N=6;const P=[...Array(N)].map((_,i)=>({smart:i===0,rack:new Map<string,number>(),bal:100,score:0}));
 for(const p of P)for(let k=0;k<5;k++){const l=draw();p.rack.set(l,(p.rack.get(l)??0)+1)}
 const play=(p:any)=>{for(let g=0;g<5;g++){const w=p.smart?smart.chooseWord({myRack:p.rack,dictionary:dict,bagLeft:bag.length,myBalance:p.bal}):dflt.word(p.rack);if(!w)return;for(const c of w)p.rack.set(c,p.rack.get(c)-1);const s=smart.wordScore(w);p.bal+=s;p.score+=s}};
 let guard=0;
 while(bag.length&&guard++<1000){const L=draw();
  const bids=P.map(p=>p.smart?smart.decideBid({letter:L,myBalance:p.bal,myRack:p.rack,bagLeft:bag.length,firstPrice:fp,dictionary:dict}):dflt.bid(L,p.bal,p.rack));
  const order=bids.map((b,i)=>[b,Math.random(),i]).filter(x=>x[0]>0).sort((a,b)=>b[0]-a[0]||a[1]-b[1]);
  if(!order.length){bag.push(L);continue}
  const w=order[0][2],paid=fp?order[0][0]:(order[1]?.[0]??1);
  if(P[w].bal>=paid){P[w].bal-=paid;P[w].rack.set(L,(P[w].rack.get(L)??0)+1)}
  for(const p of P)play(p);
 }
 const sorted=[...P].sort((a,b)=>b.score-a.score);return {place:sorted.indexOf(P[0])+1,me:P[0].score,best:Math.max(...P.slice(1).map(p=>p.score))};
}
for(const fp of[false,true]){let wins=0,pl=0,me=0,op=0;const G=40;for(let i=0;i<G;i++){const r=game(fp);if(r.place===1)wins++;pl+=r.place;me+=r.me;op+=r.best}
 console.log(fp?"first-price":"vickrey",`win ${wins}/${G}, avg place ${(pl/G).toFixed(2)}, avg score ${(me/G).toFixed(0)} vs best opp ${(op/G).toFixed(0)}`)}
