import"./modulepreload-polyfill-P2Xu9kJm.js";/* empty css             */import{c as e,d as t,f as n,l as r,o as i,r as a,s as o,u as s}from"./release-BNdNipZP.js";var c=`#version 300 es
void main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);gl_Position=vec4(p*2.-1.,0.,1.);}`,l=`#version 300 es
precision highp float;
out vec4 O;
uniform vec2 uRes; uniform float uT; uniform vec2 uMouse; uniform float uFly; uniform vec2 uShift; uniform float uCam; uniform float uIn;

mat3 rotX(float a){float c=cos(a),s=sin(a);return mat3(1,0,0,0,c,s,0,-s,c);}
mat3 rotY(float a){float c=cos(a),s=sin(a);return mat3(c,0,-s,0,1,0,s,0,c);}
float hash(vec2 p){p=fract(p*vec2(123.34,456.21));p+=dot(p,p+45.32);return fract(p.x*p.y);}
float box2(vec2 p,vec2 b,float r){vec2 q=abs(p)-b+r;return length(max(q,0.))+min(max(q.x,q.y),0.)-r;}
float smin(float a,float b,float k){float h=max(k-abs(a-b),0.)/k;return min(a,b)-h*h*k*.25;}
float pi2(vec2 p){
  float d=box2(p-vec2(0.,.73),vec2(1.,.21),.065);
  d=smin(d,box2(p-vec2(-.455,.24),vec2(.195,.70),.065),.07);
  d=smin(d,box2(p-vec2(.331,.005),vec2(.195,.935),.065),.07);
  return d;
}
float map(vec3 p){
  float d=pi2(p.xy);
  vec2 w=vec2(d+.05,abs(p.z)-.17);
  return min(max(w.x,w.y),0.)+length(max(w,0.))-.05;
}
vec3 normal(vec3 p){vec2 e=vec2(.0012,-.0012);return normalize(e.xyy*map(p+e.xyy)+e.yyx*map(p+e.yyx)+e.yxy*map(p+e.yxy)+e.xxx*map(p+e.xxx));}

vec3 env(vec3 d){
  // Softboxes: long hard-edged lights are what make glass read as glass.
  vec3 c=mix(vec3(.012,.010,.024),vec3(.05,.035,.09),smoothstep(-.6,.9,d.y));
  float top=smoothstep(.34,.40,d.y)*smoothstep(.98,.5,abs(d.x+.12))*smoothstep(-.3,.1,d.z+.2);
  c+=vec3(1.5,1.42,1.7)*top;
  float left=smoothstep(-.42,-.54,d.x)*smoothstep(.62,.4,abs(d.y-.05));
  c+=vec3(2.5,.45,1.9)*left;
  float right=smoothstep(.52,.64,d.x)*smoothstep(.55,.3,abs(d.y+.14));
  c+=vec3(.28,1.15,2.6)*right;
  float low=smoothstep(-.60,-.72,d.y)*smoothstep(.7,.3,abs(d.x-.1));
  c+=vec3(.75,.42,2.4)*low;
  // A slow sweep so the highlights stay alive while the pointer rests.
  float sw=sin(d.x*5.+d.y*2.2+uT*.32);
  c+=vec3(1.,.92,1.15)*smoothstep(.965,.995,sw)*.8;
  return c;
}
vec3 tint(vec3 p){
  float k=clamp(dot(p.xy,normalize(vec2(.62,-.78)))*.55+.5,0.,1.);
  vec3 a=vec3(.95,.31,.84),b=vec3(.61,.33,1.),c=vec3(.30,.77,1.);
  return k<.55?mix(a,b,k/.55):mix(b,c,(k-.55)/.45);
}
vec3 back(vec2 uv,vec3 rd){
  vec3 c=vec3(.0028,.0022,.0065);
  float r=length(uv);
  c+=vec3(.20,.10,.42)*exp(-r*r*1.6)*.055*uIn;
  c+=vec3(.40,.10,.36)*exp(-dot(uv-vec2(-.5,.35),uv-vec2(-.5,.35))*3.5)*.018*uIn;
  c+=vec3(.08,.22,.45)*exp(-dot(uv-vec2(.6,-.45),uv-vec2(.6,-.45))*3.5)*.024*uIn;
  // Dust: three parallax layers, streaking radially as the camera speeds up.
  float speed=uFly*uFly;
  for(int i=0;i<3;i++){
    float s=6.+float(i)*7.;
    vec2 q=uv*(1.+float(i)*.22)+vec2(uT*.006*(float(i)+1.),0.)+uMouse*.012*(float(i)+1.);
    float along=atan(q.y,q.x),rad=length(q);
    vec2 g=mix(q*s,vec2(along*7.,rad*(s*.35)),smoothstep(.15,.5,speed));
    vec2 id=floor(g),f=fract(g)-.5;
    float h=hash(id+float(i)*17.);
    if(h>.89){
      vec2 o=vec2(hash(id+3.),hash(id+7.))-.5;
      vec2 e=f-o*.7;
      e.y/=mix(1.,10.,smoothstep(.15,.6,speed));
      c+=vec3(.75,.68,1.)*smoothstep(.055,.0,length(e))*(.05+h*.09)*(.6+.4*sin(uT*(h*2.)+h*50.))*uIn;
    }
  }
  return c;
}
vec3 aces(vec3 x){return clamp((x*(2.51*x+.03))/(x*(2.43*x+.59)+.14),0.,1.);}

void main(){
  vec2 uv=(gl_FragCoord.xy-.5*uRes)/min(uRes.x,uRes.y*1.25)*1.25;
  vec2 suv=uv-uShift;
  float fly=smoothstep(0.,1.,uFly);
  // Fly through the arch between the legs.
  vec3 ro=vec3(mix(0.,-.06,fly),mix(.03,-.12,fly),mix(uCam,-1.8,fly*fly));
  vec3 rd=normalize(vec3(suv,-mix(1.85,1.05,fly)));
  float idle=1.-fly;
  mat3 R=rotY((-.42+uMouse.x*.34+sin(uT*.24)*.09)*idle)*rotX((.10-uMouse.y*.20+cos(uT*.19)*.05)*idle);
  mat3 Ri=transpose(R);
  vec3 o=Ri*ro,d=Ri*rd;
  vec3 col=back(uv,rd);
  // Bounding box: most pixels never need the march.
  vec3 bmin=vec3(-1.15,-1.05,-.32),bmax=vec3(1.15,1.05,.32);
  vec3 t0=(bmin-o)/d,t1=(bmax-o)/d;
  vec3 tn=min(t0,t1),tf=max(t0,t1);
  float near=max(max(tn.x,tn.y),max(tn.z,0.)),far=min(min(tf.x,tf.y),tf.z);
  float glow=1e3;
  if(far>near&&far>0.){
    float t=near;bool hit=false;
    for(int i=0;i<72;i++){
      float h=map(o+d*t);
      glow=min(glow,h);
      if(h<.0012){hit=true;break;}
      t+=h*.92;
      if(t>far)break;
    }
    if(hit){
      vec3 p=o+d*t,n=normal(p);
      vec3 wn=R*n;
      float F=.04+.96*pow(clamp(1.+dot(d,n),0.,1.),5.);
      vec3 refl=env(reflect(rd,wn));
      vec3 ri=refract(d,n,1./1.5);
      vec3 q=p-n*.006;float s=.02;
      for(int i=0;i<30;i++){
        float h=-map(q+ri*s);
        if(h<.0015)break;
        s+=max(h,.004);
      }
      vec3 pe=q+ri*s,n2=-normal(pe);
      vec3 tr;
      for(int c=0;c<3;c++){
        float ior=1.42+float(c)*.075;
        vec3 ro2=refract(ri,n2,ior);
        if(dot(ro2,ro2)<.01)ro2=reflect(ri,n2);
        tr[c]=env(R*ro2)[c];
      }
      vec3 tc=tint(p);
      vec3 ab=exp(-(1.-tc)*(s*3.1+.34));
      vec3 inner=tr*ab+tc*tc*(.10+.10*smoothstep(.0,.9,s));
      // Edge light: the bevel picks up the brand colour.
      float rim=pow(clamp(1.+dot(d,n),0.,1.),2.4);
      inner+=tc*rim*.38;
      vec3 m=mix(inner,refl,F);
      vec3 L=normalize(vec3(-.4,.8,.5));
      m+=vec3(1.)*pow(max(dot(reflect(rd,wn),L),0.),140.)*1.5;
      col=mix(col,m,uIn);
    }
  }
  if(glow<1e2)col+=tint(vec3(uv*1.2,0.))*exp(-max(glow,0.)*16.)*.03*idle*uIn;
  col=aces(col*1.12);
  col=pow(col,vec3(.4545));
  col*=1.-.26*dot(uv,uv)*idle;
  // Passing through the arch: light opens up to the exact colour the next scene starts from.
  col=mix(col,vec3(.302,.169,.733),smoothstep(.7,1.,uFly));
  col+=(hash(gl_FragCoord.xy+fract(uT)*91.)-.5)/255.*1.6;
  O=vec4(col,1.);
}`;function u(e,t,n){let r=e.createShader(t);if(e.shaderSource(r,n),e.compileShader(r),!e.getShaderParameter(r,e.COMPILE_STATUS))throw Error(e.getShaderInfoLog(r)??`shader`);return r}function d(e){let t=e.getContext(`webgl2`,{antialias:!1,alpha:!1,powerPreference:`high-performance`});if(!t)return null;let n;try{if(n=t.createProgram(),t.attachShader(n,u(t,t.VERTEX_SHADER,c)),t.attachShader(n,u(t,t.FRAGMENT_SHADER,l)),t.linkProgram(n),!t.getProgramParameter(n,t.LINK_STATUS))throw Error(t.getProgramInfoLog(n)??`link`)}catch(e){return console.warn(`glass shader unavailable`,e),null}t.useProgram(n),t.bindVertexArray(t.createVertexArray());let r=e=>t.getUniformLocation(n,e),i={res:r(`uRes`),t:r(`uT`),mouse:r(`uMouse`),fly:r(`uFly`),shift:r(`uShift`),cam:r(`uCam`),intro:r(`uIn`)},a={fly:0,shiftX:0,shiftY:0,cam:4.4,intro:0},o={x:0,y:0},s={x:0,y:0};addEventListener(`pointermove`,e=>{o.x=e.clientX/innerWidth*2-1,o.y=e.clientY/innerHeight*2-1},{passive:!0});let d=Math.min(devicePixelRatio||1,1.5),f=.6,p=()=>{let n=Math.round(e.clientWidth*d),r=Math.round(e.clientHeight*d);(e.width!==n||e.height!==r)&&(e.width=n,e.height=r,t.viewport(0,0,n,r))};new ResizeObserver(p).observe(e);let m=performance.now(),h=n=>{p(),s.x+=(o.x-s.x)*.05,s.y+=(o.y-s.y)*.05,t.uniform2f(i.res,e.width,e.height),t.uniform1f(i.t,(n-m)/1e3),t.uniform2f(i.mouse,s.x,s.y),t.uniform1f(i.fly,a.fly),t.uniform2f(i.shift,a.shiftX,a.shiftY),t.uniform1f(i.cam,a.cam),t.uniform1f(i.intro,a.intro),t.drawArrays(t.TRIANGLES,0,3)},g=!1,_=0,v=0,y=0,b=e=>{_=requestAnimationFrame(b);let t=e-v;v=e,t>26&&t<200?++y>24&&d>f&&(d=Math.max(f,d*.82),y=0):y>0&&--y,h(e)};return e.addEventListener(`webglcontextlost`,t=>{t.preventDefault(),cancelAnimationFrame(_),g=!1,e.style.display=`none`}),{state:a,setActive(e){e!==g&&(g=e,cancelAnimationFrame(_),e&&(v=performance.now(),_=requestAnimationFrame(b)))},renderOnce(){h(performance.now())}}}var f=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" fill="currentColor"><path d="M104,144v51.64a8,8,0,0,1-8,8,8.54,8.54,0,0,1-1.43-.13l-64-11.64A8,8,0,0,1,24,184V144a8,8,0,0,1,8-8H96A8,8,0,0,1,104,144Zm-2.87-89.78a8,8,0,0,0-6.56-1.73l-64,11.64A8,8,0,0,0,24,72v40a8,8,0,0,0,8,8H96a8,8,0,0,0,8-8V60.36A8,8,0,0,0,101.13,54.22ZM208,136H128a8,8,0,0,0-8,8v57.45a8,8,0,0,0,6.57,7.88l80,14.54A7.61,7.61,0,0,0,208,224a8,8,0,0,0,8-8V144A8,8,0,0,0,208,136Zm5.13-102.14a8,8,0,0,0-6.56-1.73l-80,14.55A8,8,0,0,0,120,54.55V112a8,8,0,0,0,8,8h80a8,8,0,0,0,8-8V40A8,8,0,0,0,213.13,33.86Z"/></svg>`,p=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" fill="currentColor"><path d="M128.23,30A40,40,0,0,1,167,0h1a8,8,0,0,1,0,16h-1a24,24,0,0,0-23.24,18,8,8,0,1,1-15.5-4ZM223.3,169.59a8.07,8.07,0,0,0-2.8-3.4C203.53,154.53,200,134.64,200,120c0-17.67,13.47-33.06,21.5-40.67a8,8,0,0,0,0-11.62C208.82,55.74,187.82,48,168,48a72.23,72.23,0,0,0-40,12.13,71.56,71.56,0,0,0-90.71,9.09A74.63,74.63,0,0,0,16,123.4a127,127,0,0,0,40.14,89.73A39.8,39.8,0,0,0,83.59,224h87.68a39.84,39.84,0,0,0,29.12-12.57,125,125,0,0,0,17.82-24.6C225.23,174,224.33,172,223.3,169.59Z"/></svg>`,m=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" fill="currentColor"><path d="M216,104v8a56.06,56.06,0,0,1-48.44,55.47A39.8,39.8,0,0,1,176,192v40a8,8,0,0,1-8,8H104a8,8,0,0,1-8-8V216H72a40,40,0,0,1-40-40A24,24,0,0,0,8,152a8,8,0,0,1,0-16,40,40,0,0,1,40,40,24,24,0,0,0,24,24H96v-8a39.8,39.8,0,0,1,8.44-24.53A56.06,56.06,0,0,1,56,112v-8a58.14,58.14,0,0,1,7.69-28.32A59.78,59.78,0,0,1,69.07,28,8,8,0,0,1,76,24a59.75,59.75,0,0,1,48,24h24a59.75,59.75,0,0,1,48-24,8,8,0,0,1,6.93,4,59.74,59.74,0,0,1,5.37,47.68A58,58,0,0,1,216,104Z"/></svg>`,h=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" fill="currentColor"><path d="M208.49,152.49l-72,72a12,12,0,0,1-17,0l-72-72a12,12,0,0,1,17-17L116,187V40a12,12,0,0,1,24,0V187l51.51-51.52a12,12,0,0,1,17,17Z"/></svg>`;n.registerPlugin(t);var g=(e,t=document)=>t.querySelector(e),_=(e,t=document)=>Array.from(t.querySelectorAll(e)),v=(e,t=0,n=1)=>Math.min(n,Math.max(t,e)),y=(e,t,n)=>{let r=v((n-e)/(t-e));return r*r*(3-2*r)},b=(e,t,n)=>e+(t-e)*n,x=[{id:`plan`,tab:`计划与审批`,title:`计划先过目，再动手`,body:`Plan 预览可以逐段批注，批准后才执行。Ask 卡片和权限档位把决定权留给你。`},{id:`hub`,tab:`Agent Hub`,title:`每个子 Agent 都看得见`,body:`名册里盯状态、花费和上下文占用。选中一个，看血缘和实时记录，能恢复也能终止。`},{id:`tokens`,tab:`Token 与成本`,title:`这一轮花了多少，一眼算清`,body:`顶栏展开用量、缓存命中和 Context 构成，首页有按年月周切换的曲线和热力图。`},{id:`models`,tab:`模型与角色`,title:`60+ 供应商，一页管完`,body:`开关、端点和优先顺序同页完成。@default、@plan、@task 各配模型和思考强度。`},{id:`caps`,tab:`能力中心`,title:`Skills、MCP、Slash 收在一处`,body:`Skills、Plugins、MCP、Slash Commands 同一页开关、探测和打开目录。`},{id:`git`,tab:`Git`,title:`Git 就在对话旁边`,body:`暂存、看 diff、写 commit，Fetch、Pull、Push 和提交图都不用离开工作台。`}],S=matchMedia(`(prefers-reduced-motion: reduce)`).matches,C=matchMedia(`(min-width: 900px) and (pointer: fine)`).matches&&!S;document.documentElement.classList.add(C?`is-full`:`is-plain`);var w=null;C&&(w=new s({lerp:.11,wheelMultiplier:.9}),w.on(`scroll`,t.update),n.ticker.add(e=>w?.raf(e*1e3)),n.ticker.lagSmoothing(0));var T=e=>{let t=g(e);t&&(w?w.scrollTo(t,{duration:1.6,easing:e=>1-(1-e)**3}):t.scrollIntoView({behavior:S?`auto`:`smooth`}))};for(let e of _(`a[href^="#"]`))e.addEventListener(`click`,t=>{t.preventDefault(),T(e.getAttribute(`href`))});var E=g(`#glass`),D=d(E),O=()=>1.25/Math.min(innerWidth,innerHeight*1.25),k=e=>1.7575/(O()*e),A=()=>innerWidth>=900,j=()=>A()?{shiftX:innerWidth*.24*O(),shiftY:-.02,cam:k(Math.min(innerHeight*.33,innerWidth*.17))}:{shiftX:0,shiftY:innerHeight*.2*O(),cam:k(118)},M=j(),N={fly:0,shiftX:M.shiftX,shiftY:M.shiftY,cam:M.cam,intro:0},P=()=>g(`.final-inner`).getBoundingClientRect().top+parseFloat(getComputedStyle(g(`.final-inner`)).paddingTop)/2,F=()=>k(A()?150:104),I={fly:0,shiftX:0,shiftY:0,cam:F()+4,intro:0},L=!0,R=!1,z=()=>{if(!D)return;R&&(I.shiftY=(innerHeight/2-P())*O());let e=R?I:N,t=D.state;t.fly=e.fly,t.shiftX=e.shiftX,t.shiftY=e.shiftY,t.cam=e.cam,t.intro=e.intro,S?D.renderOnce():D.setActive(L||R)};if(D?(S?(N.intro=1,I.intro=1,I.cam=F()):(n.to(N,{intro:1,duration:1.8,ease:`power2.out`,delay:.1}),n.fromTo(N,{cam:M.cam+2.6},{cam:M.cam,duration:2.4,ease:`expo.out`}),n.ticker.add(z)),z(),new IntersectionObserver(e=>{R=e[0].isIntersecting,R&&!S&&n.fromTo(I,{cam:F()+4,intro:0},{cam:F(),intro:1,duration:2.2,ease:`expo.out`,overwrite:!0}),z()},{rootMargin:`0px 0px -12% 0px`}).observe(g(`.final`)),S&&addEventListener(`scroll`,()=>R&&z(),{passive:!0}),C||new IntersectionObserver(e=>{L=e[0].isIntersecting,z()}).observe(g(`.hero`))):(E.remove(),document.documentElement.classList.add(`no-glass`)),S||document.fonts.ready.then(()=>{n.from(`.hero h1 .ln > span`,{yPercent:112,duration:1.15,ease:`expo.out`,stagger:.09,delay:.15}),n.from(`.hero-sub, .hero-cta`,{opacity:0,y:18,duration:1,ease:`power3.out`,stagger:.08,delay:.5}),n.from(`.nav`,{opacity:0,y:-10,duration:.9,ease:`power2.out`,delay:.7})}),C){let e=n.timeline({scrollTrigger:{trigger:`.hero`,start:`top top`,end:`+=130%`,pin:!0,scrub:!0,anticipatePin:1,onToggle:e=>{L=e.isActive,z()}}});e.to(`.hero-copy`,{y:-80,opacity:0,duration:.35,ease:`power1.in`},0),D&&(e.to(N,{fly:1,shiftX:0,shiftY:0,duration:1,ease:`power2.in`},0),addEventListener(`resize`,()=>{let n=j();N.cam=n.cam,scrollY<2&&Object.assign(N,{shiftX:n.shiftX,shiftY:n.shiftY}),e.invalidate(),t.refresh()})),B(),H(),n.from(`.nope s`,{"--strike":0,duration:.9,ease:`power3.inOut`,stagger:.14,scrollTrigger:{trigger:`.nope`,start:`top 78%`}}),n.fromTo(`.pipe-fill`,{scaleX:0},{scaleX:1,ease:`none`,scrollTrigger:{trigger:`.pipe`,start:`top 86%`,end:`top 40%`,scrub:!0}}),n.from(`.pipe li`,{opacity:0,y:18,duration:.8,ease:`power3.out`,stagger:.07,scrollTrigger:{trigger:`.pipe`,start:`top 72%`}});let r=n.fromTo(`.pk-down`,{left:`0%`},{left:`100%`,duration:2.8,ease:`none`,repeat:-1,repeatDelay:.5,paused:!0}),i=n.fromTo(`.pk-up`,{left:`100%`},{left:`0%`,duration:2.8,ease:`none`,repeat:-1,repeatDelay:.5,delay:1.5,paused:!0});t.create({trigger:`.bridge`,start:`top bottom`,end:`bottom top`,onToggle:e=>e.isActive?(r.play(),i.play()):(r.pause(),i.pause())}),n.from(`.laws > div`,{opacity:0,y:22,duration:.8,ease:`power3.out`,stagger:.08,scrollTrigger:{trigger:`.laws`,start:`top 84%`}}),n.from(`.more-title`,{opacity:0,y:28,duration:1,ease:`power3.out`,scrollTrigger:{trigger:`.more-title`,start:`top 85%`}}),n.from(`.tile`,{opacity:0,y:48,duration:1,ease:`power3.out`,stagger:.07,scrollTrigger:{trigger:`.mosaic`,start:`top 80%`}}),n.from(`.final-inner > *`,{opacity:0,y:26,duration:.9,ease:`power3.out`,stagger:.06,scrollTrigger:{trigger:`.final-inner`,start:`top 70%`}})}else U();function B(){let e=g(`.world`),r=g(`#win`),i=g(`#seq`),a=i.getContext(`2d`,{alpha:!1}),o=_(`[data-say]`),s=_(`[data-cap]`),c=[{t:`tmux: agent-1`,b:`$ omp
> 修一下 TS2322
  thinking...
  bash: npm run typecheck
  error TS2322: Type 'string' is
  not assignable to type 'number'`},{t:`provider console`,b:`API Keys
Usage this month
Rate limits
Invoices`,web:!0},{t:`tmux: agent-2`,b:`$ omp --resume
  which session?
  3a1f  yesterday
  9c02  2 days ago
  77de  last week`},{t:`git log --graph`,b:`* 13fc431 merge
|\\
| * b4431e5 test
* | 1a95443 test
|/
* cb17b74 merge`},{t:`pull request`,b:`Files changed  12
Conversation  4
Checks  1 failing`,web:!0},{t:`models.yml`,b:`providers:
  anthropic:
  openai:
  openrouter:
modelRoles:
  default:
  plan:
  task:`},{t:`billing`,b:`Credits remaining
Daily spend
Export CSV`,web:!0},{t:`zsh`,b:`$ git diff --stat
 main.tsx | 3 ++-
 1 file changed
$ _`},{t:`docs: mcp servers`,b:`Configuration
Transport
Authentication`,web:!0},{t:`tmux: agent-3`,b:`  subagent spawned
  subagent spawned
  ... which one is stuck?`},{t:`scratch.md`,b:`TODO
- 问 agent-2 进度
- 今天花了多少?
- skill 放哪个目录来着`},{t:`dashboard`,b:`Tokens
Cache hit
Latency p95`,web:!0},{t:`htop`,b:`PID  CPU%  CMD
912  38.1  bun
930  12.4  omp
954   7.7  node`},{t:`zsh`,b:`$ tail -f agent.log
[warn] compact
[info] tool call
[info] tool call`}],l=7,u=()=>((l=l*16807%2147483647)-1)/2147483646,d=[];for(let t=0;t<26;t++){let n=c[t%c.length],r=document.createElement(`div`);r.className=`panel${n.web?` panel-web`:``}`,r.innerHTML=`<header>${n.t}</header><pre></pre>`,r.querySelector(`pre`).textContent=n.b,e.append(r);let i=t%2?1:-1,a=i*b(.2,.62,u()),o=b(-.42,.42,u());d.push({el:r,x:a,y:o,z:-300-t/26*5600,ry:-i*b(8,26,u())})}let f=e=>{let t=innerWidth,n=innerHeight;for(let r of d){let i=r.z+e,a=y(-3400,-2200,i)*(1-y(-40,340,i));a<=.002?r.el.style.visibility!==`hidden`&&(r.el.style.visibility=`hidden`):(r.el.style.visibility=`visible`,r.el.style.opacity=a.toFixed(3),r.el.style.transform=`translate3d(${(r.x*t).toFixed(1)}px,${(r.y*n).toFixed(1)}px,${i.toFixed(1)}px) rotateY(${r.ry.toFixed(2)}deg)`)}},p=Array(170).fill(null),m=-1,h=0,x=e=>{let t=e;for(let n=0;n<170;n++){if(p[e-n]){t=e-n;break}if(p[e+n]){t=e+n;break}}p[t]&&t!==m&&(a.drawImage(p[t],0,0,i.width,i.height),m=t)},S=async e=>{let t=new Image;t.src=`../media/seq/chat/${String(e).padStart(4,`0`)}.webp`;try{await t.decode(),p[e]=t,(m<0||Math.abs(e-h)<Math.abs(m-h))&&x(h)}catch{}},C=!1,w=async()=>{if(!C){C=!0,await S(0);for(let e of[16,8,4,2,1]){let t=[];for(let n=e;n<170;n+=e)p[n]||(t.push(S(n)),t.length>=6&&(await Promise.all(t),t.length=0));await Promise.all(t)}}};t.create({trigger:`.passage`,start:`top 300%`,once:!0,onEnter:()=>void w()});let T=[{f:0,s:1,x:.5,y:.5},{f:8,s:1,x:.5,y:.5},{f:20,s:1.42,x:.6,y:.3},{f:66,s:1.42,x:.6,y:.4},{f:80,s:1.55,x:.6,y:.42},{f:98,s:1.55,x:.6,y:.42},{f:112,s:1.42,x:.6,y:.5},{f:135,s:1.42,x:.6,y:.38},{f:156,s:1.6,x:.6,y:.55},{f:169,s:1.6,x:.6,y:.55}],E=e=>{let t=T[0],n=T[T.length-1];for(let r=0;r<T.length-1;r++)if(e>=T[r].f&&e<=T[r+1].f){t=T[r],n=T[r+1];break}let r=y(t.f,n.f,e);return{s:b(t.s,n.s,r),x:b(t.x,n.x,r),y:b(t.y,n.y,r)}},D=[[.325,.385],[.395,.56],[.57,.695],[.705,.83],[.85,.955]],O=[.2,.31],k=[.31,.955],A=g(`.flash`),j=e=>{A.style.opacity=String(1-y(0,.028,e)),f(y(0,.29,e)*6100),o[0].style.opacity=String(y(.005,.03,e)*(1-y(.075,.1,e))),o[0].style.transform=`translateZ(${b(-90,110,y(0,.1,e)).toFixed(1)}px)`,o[1].style.opacity=String(y(.1,.125,e)*(1-y(.19,.215,e))),o[1].style.transform=`translateZ(${b(-90,110,y(.1,.215,e)).toFixed(1)}px)`;let t=y(O[0],O[1],e),n=y(.968,1,e),a=b(-2800,0,1-(1-t)**2.2);r.style.opacity=String(y(O[0],O[0]+.05,e)*(1-n)),r.style.transform=`translate3d(0,${(n*-36).toFixed(1)}px,${a.toFixed(1)}px) rotateX(${((1-t)*7).toFixed(2)}deg) scale(${(1-n*.05).toFixed(4)})`;let c=v((e-k[0])/(k[1]-k[0]))*169;h=Math.round(c),x(h);let l=E(c),u=i.clientWidth,d=i.clientHeight,p=v(u/2-l.x*u*l.s,u-u*l.s,0),m=v(d/2-l.y*d*l.s,d-d*l.s,0);i.style.transform=`translate3d(${p.toFixed(2)}px,${m.toFixed(2)}px,0) scale(${l.s.toFixed(4)})`,s.forEach((t,n)=>{let[r,i]=D[n],a=y(r,r+.016,e)*(1-y(i-.012,i,e));t.style.opacity=a.toFixed(3),t.style.transform=`translateY(${((1-a)*16).toFixed(1)}px)`,t.style.visibility=a<.004?`hidden`:`visible`})};t.create({trigger:`.passage`,start:`top top`,end:`+=720%`,pin:`.stage`,pinSpacing:!0,anticipatePin:1,onEnter:()=>n.set(`.stage`,{autoAlpha:1}),onLeaveBack:()=>n.set(`.stage`,{autoAlpha:0}),onUpdate:e=>j(e.progress),onRefresh:e=>{n.set(`.stage`,{autoAlpha:+(e.progress>0||scrollY>=e.start)}),j(e.progress)}}),j(0)}function V(e){let t=document.createElement(`div`);return t.className=`ch-card`,t.dataset.id=e.id,t.innerHTML=`<div class="ch-tilt"><video muted loop playsinline preload="none" poster="../media/poster/${e.id}.webp" src="../media/clip/${e.id}.mp4" aria-label="${e.tab}录屏"></video></div>`,t}function H(){let e=g(`.ch-track`),r=g(`.ch-titles`),i=g(`.ch-tabs`),a=x.map((t,n)=>{let a=V(t);e.append(a);let o=document.createElement(`div`);o.className=`ch-title`,o.innerHTML=`<h2>${t.title}</h2><p>${t.body}</p>`,r.append(o);let c=document.createElement(`button`);return c.type=`button`,c.textContent=t.tab,c.setAttribute(`role`,`tab`),c.addEventListener(`click`,()=>{let e=s;if(!e)return;let t=e.start+(e.end-e.start)*(n/(x.length-1));w?.scrollTo(t,{duration:1.3,easing:e=>1-(1-e)**3})}),i.append(c),{el:a,tilt:a.querySelector(`.ch-tilt`),video:a.querySelector(`video`),title:o,tab:c}}),o=document.createElement(`i`);o.className=`ch-ink`,i.append(o);let s=null,c=-1,l=e=>{if(e===c)return;a[c]?.video.pause(),c=e;let t=a[e];(s?.isActive||e===0)&&(t.video.currentTime=0,t.video.play().catch(()=>{})),a.forEach((t,n)=>{t.tab.setAttribute(`aria-selected`,String(n===e))}),o.style.width=`${t.tab.offsetWidth}px`,o.style.transform=`translateX(${t.tab.offsetLeft}px)`},u={rx:0,ry:0,tx:0,ty:0};g(`.ch-stage`).addEventListener(`pointermove`,e=>{let t=e;u.ty=(t.clientX/innerWidth*2-1)*3.2,u.tx=-(t.clientY/innerHeight*2-1)*2.4});let d=t=>{let n=t*(x.length-1),r=e.clientWidth;a.forEach((e,t)=>{let i=t-n,a=Math.abs(i),o=i*r*.84,s=-a*260,c=-i*24;e.el.style.transform=`translate3d(${o.toFixed(1)}px,${(a*18).toFixed(1)}px,${s.toFixed(1)}px) rotateY(${c.toFixed(2)}deg)`,e.el.style.opacity=String(v(1-(a-.2)*.72)),e.el.style.visibility=a>2.1?`hidden`:`visible`,e.el.style.pointerEvents=a<.5?`auto`:`none`;let l=1-y(.16,.42,a);e.title.style.opacity=l.toFixed(3),e.title.style.transform=`translateX(${(i*90).toFixed(1)}px)`,e.title.style.visibility=l<.004?`hidden`:`visible`}),l(Math.round(n))};n.ticker.add(()=>{u.rx+=(u.tx-u.rx)*.06,u.ry+=(u.ty-u.ry)*.06;let e=a[c];e&&(e.tilt.style.transform=`rotateX(${u.rx.toFixed(3)}deg) rotateY(${u.ry.toFixed(3)}deg)`)}),s=t.create({trigger:`.chapters`,start:`top top`,end:`+=${x.length*85}%`,pin:`.ch-stage`,anticipatePin:1,snap:{snapTo:1/(x.length-1),duration:{min:.25,max:.7},delay:.08,ease:`power2.inOut`},onUpdate:e=>d(e.progress),onRefresh:e=>d(e.progress),onToggle:e=>{let t=a[c];t&&(e.isActive?t.video.play().catch(()=>{}):t.video.pause())}}),d(0)}function U(){let e=g(`.ch-stage`);e.innerHTML=``;let t=document.createElement(`div`);t.className=`ch-rail`;for(let e of x){let n=document.createElement(`article`);n.innerHTML=`<h2>${e.title}</h2><p>${e.body}</p><video data-lazy data-src="../media/clip/${e.id}.mp4" poster="../media/poster/${e.id}.webp" muted loop playsinline></video>`,t.append(n)}e.append(t)}function W(){let e=new IntersectionObserver(e=>{for(let t of e){let e=t.target;t.isIntersecting?(e.src||=e.dataset.src,S||e.play().catch(()=>{})):e.pause()}},{rootMargin:`200px 0px`,threshold:.15});for(let t of _(`video[data-lazy]`))S&&(t.controls=!0),e.observe(t)}W();for(let e of _(`.tile`))e.addEventListener(`pointermove`,t=>{let n=e.getBoundingClientRect(),r=t;e.style.setProperty(`--mx`,`${r.clientX-n.left}px`),e.style.setProperty(`--my`,`${r.clientY-n.top}px`)});{let e=[`deepseek`,`gemini`,`mistral`,`nvidia`,`kimi`,`qwen`,`zhipu`,`alibaba`,`azure`,`cloudflare`,`huggingface`,`minimax`,`perplexity`,`together`,`fireworks`,`siliconflow`,`cerebras`],t=g(`.logos-track`);for(let n of[0,1])for(let r of e){let e=document.createElement(`img`);e.src=`../media/brands/${r}.svg`,e.alt=n?``:r,e.width=34,e.height=34,e.loading=`lazy`,r===`kimi`&&(e.className=`logo-ink`),t.append(e)}}if(C)for(let e of _(`.magnetic`)){let t=n.quickTo(e,`x`,{duration:.55,ease:`power3.out`}),r=n.quickTo(e,`y`,{duration:.55,ease:`power3.out`});e.addEventListener(`pointermove`,n=>{let i=e.getBoundingClientRect(),a=n;t((a.clientX-i.left-i.width/2)*.22),r((a.clientY-i.top-i.height/2)*.32)}),e.addEventListener(`pointerleave`,()=>{t(0),r(0)})}var G={"win-x64":f,"win-arm64":f,"mac-arm64":p},K=e=>e===`mac-arm64`?a.mac:a.win;function q(t,n){for(let e of _(`[data-version]`))e.textContent=t.version;for(let e of _(`[data-date]`))e.textContent=t.publishedAt;if(t.stars!==null){let e=g(`[data-stars]`);e.textContent=String(t.stars),e.setAttribute(`aria-label`,`GitHub ${t.stars} stars`)}let r=t.assets.find(e=>e.platform===n);for(let t of _(`[data-primary]`)){t.href=r?.url??`https://github.com/the-snowpear/omp-studio/releases`;let n=g(`[data-primary-label]`,t),i=!t.classList.contains(`btn-big`);n.textContent=r?i?`下载 ${r.label.split(` `)[0]} 版`:`下载 ${r.label}`:`前往下载页`;let a=t.querySelector(`.ico`);if(a)r&&(a.innerHTML=G[r.platform]);else{let e=document.createElement(`span`);e.className=`ico`,e.innerHTML=r?G[r.platform]:h,t.prepend(e)}let o=t.querySelector(`[data-primary-size]`);o&&(o.textContent=r?e(r.bytes):``)}let i=g(`[data-note]`);i.textContent=r?K(r.platform):`这台设备暂时没有桌面安装包，可以在电脑上打开本页，或从源码运行。`;let a=g(`[data-others]`);a.innerHTML=``;for(let n of t.assets){if(n===r)continue;let t=document.createElement(`li`);t.innerHTML=`<a href="${n.url}"><span class="ico">${G[n.platform]}</span><span class="o-name">${n.label}<small>${n.detail}</small></span><span class="o-size">${e(n.bytes)}</span></a><p>${K(n.platform)}</p>`,a.append(t)}}(async()=>{let e=await o();q(i,e);let t=await r();t!==i&&q(t,e)})(),g(`[data-icon=github]`).insertAdjacentHTML(`afterbegin`,`<span class="ico">${m}</span>`);var J=g(`[data-copy]`);J.addEventListener(`click`,async()=>{try{await navigator.clipboard.writeText(g(`.cmd code`).textContent??``),J.textContent=`已复制`}catch{J.textContent=`复制失败，请手动选择`}setTimeout(()=>J.textContent=`复制`,1800)}),window.addEventListener(`load`,()=>t.refresh()),document.fonts?.ready.then(()=>t.refresh());