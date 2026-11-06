/**
 * Raymarched glass π, raw WebGL2. One fragment shader, no scene graph.
 * The mark is an extruded 2D signed distance field of the icon's three bars. Light comes from a
 * procedural softbox environment; dispersion refracts each colour channel with its own IOR on
 * exit, and the glass absorbs along the icon's pink, violet, cyan diagonal.
 */
const VERT = `#version 300 es
void main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);gl_Position=vec4(p*2.-1.,0.,1.);}`;

const FRAG = `#version 300 es
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
}`;

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader");
  return s;
}

export type Glass = {
  /** Scene state; plain fields read every frame, so gsap can tween them directly. */
  state: { fly: number; shiftX: number; shiftY: number; cam: number; intro: number };
  setActive(on: boolean): void;
  renderOnce(): void;
};

export function createGlass(canvas: HTMLCanvasElement): Glass | null {
  const gl = canvas.getContext("webgl2", { antialias: false, alpha: false, powerPreference: "high-performance" });
  if (!gl) return null;
  let prog: WebGLProgram;
  try {
    prog = gl.createProgram()!;
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? "link");
  } catch (e) {
    console.warn("glass shader unavailable", e);
    return null;
  }
  gl.useProgram(prog);
  gl.bindVertexArray(gl.createVertexArray());
  const u = (n: string) => gl.getUniformLocation(prog, n);
  const U = { res: u("uRes"), t: u("uT"), mouse: u("uMouse"), fly: u("uFly"), shift: u("uShift"), cam: u("uCam"), intro: u("uIn") };

  const state = { fly: 0, shiftX: 0, shiftY: 0, cam: 4.4, intro: 0 };
  const target = { x: 0, y: 0 };
  const mouse = { x: 0, y: 0 };
  addEventListener("pointermove", (e) => {
    target.x = (e.clientX / innerWidth) * 2 - 1;
    target.y = (e.clientY / innerHeight) * 2 - 1;
  }, { passive: true });

  // Adaptive resolution: start sharp, step down when frames run long, never oscillate upward.
  let scale = Math.min(devicePixelRatio || 1, 1.5);
  const minScale = 0.6;
  const resize = () => {
    const w = Math.round(canvas.clientWidth * scale);
    const h = Math.round(canvas.clientHeight * scale);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      gl.viewport(0, 0, w, h);
    }
  };
  new ResizeObserver(resize).observe(canvas);

  const start = performance.now();
  const draw = (now: number) => {
    resize();
    mouse.x += (target.x - mouse.x) * 0.05;
    mouse.y += (target.y - mouse.y) * 0.05;
    gl.uniform2f(U.res, canvas.width, canvas.height);
    gl.uniform1f(U.t, (now - start) / 1000);
    gl.uniform2f(U.mouse, mouse.x, mouse.y);
    gl.uniform1f(U.fly, state.fly);
    gl.uniform2f(U.shift, state.shiftX, state.shiftY);
    gl.uniform1f(U.cam, state.cam);
    gl.uniform1f(U.intro, state.intro);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };

  let active = false;
  let raf = 0;
  let last = 0;
  let slow = 0;
  const loop = (now: number) => {
    raf = requestAnimationFrame(loop);
    const dt = now - last;
    last = now;
    if (dt > 26 && dt < 200) {
      if (++slow > 24 && scale > minScale) {
        scale = Math.max(minScale, scale * 0.82);
        slow = 0;
      }
    } else if (slow > 0) slow -= 1;
    draw(now);
  };
  canvas.addEventListener("webglcontextlost", (e) => {
    e.preventDefault();
    cancelAnimationFrame(raf);
    active = false;
    canvas.style.display = "none";
  });
  return {
    state,
    setActive(on) {
      if (on === active) return;
      active = on;
      cancelAnimationFrame(raf);
      if (on) {
        last = performance.now();
        raf = requestAnimationFrame(loop);
      }
    },
    renderOnce() {
      draw(performance.now());
    },
  };
}
