// The desk's wallpaper: sheets of coloured paper in the π mark's hues, drawn by a small
// fragment shader. It drifts slowly, and swells under whatever is being carried across
// it, so a dragged window feels like it is resting on something. Drawn at a fraction of
// the screen's resolution and only while on screen; without WebGL the CSS gradient
// underneath stays, and with reduced motion it is painted once and left alone.
export interface Wall {
  setDark(dark: boolean): void;
  /** Something is being carried over the wall, at a point on the screen. */
  press(x: number, y: number): void;
  release(): void;
}

const VERT = "attribute vec2 a;void main(){gl_Position=vec4(a,0.,1.);}";
const FRAG = `precision highp float;
uniform vec2 u_res;uniform float u_t;uniform float u_dark;uniform vec3 u_p;
float rand(vec2 p){return fract(sin(dot(p,vec2(12.9898,78.233)))*43758.5453);}
void main(){
  vec2 uv=gl_FragCoord.xy/u_res;
  vec2 k=vec2(u_res.x/u_res.y,1.);
  vec2 p=(uv-.5)*k;
  vec2 d=p-(u_p.xy-.5)*k;
  p-=d*exp(-dot(d,d)*6.)*u_p.z*.5;
  float t=u_t*.07;
  p=mat2(.848,-.53,.53,.848)*p;
  vec3 col=mix(vec3(.86,.91,1.),vec3(.035,.05,.12),u_dark);
  float px=1.6/u_res.y;
  for(int i=0;i<5;i++){
    float f=float(i);
    float e=-.62+f*.27+.15*sin(p.x*(1.25+.22*f)+t*(.7+.12*f)+f*2.2)+.05*sin(p.x*2.9-t*1.1+f*1.4);
    float y=p.y-e;
    float on=smoothstep(-px,px,y);
    // The sheet below darkens toward the one lying on it; each sheet is brightest along its edge.
    col*=1.-mix(.17,.5,u_dark)*exp(min(y,0.)*mix(13.,9.,u_dark))*(1.-on);
    vec3 hi=i==0?vec3(.80,.89,1.):i==1?vec3(.66,.80,1.):i==2?vec3(.62,.66,.995):i==3?vec3(.71,.60,.985):vec3(.93,.62,.93);
    vec3 lo=i==0?vec3(.66,.81,1.):i==1?vec3(.56,.64,.99):i==2?vec3(.58,.50,.96):i==3?vec3(.80,.53,.95):vec3(.98,.55,.82);
    vec3 dhi=i==0?vec3(.06,.14,.30):i==1?vec3(.09,.20,.44):i==2?vec3(.17,.17,.50):i==3?vec3(.30,.16,.55):vec3(.52,.13,.46);
    vec3 dlo=i==0?vec3(.04,.08,.19):i==1?vec3(.06,.10,.28):i==2?vec3(.12,.08,.33):i==3?vec3(.24,.07,.35):vec3(.34,.05,.24);
    float g2=smoothstep(0.,.55,y);
    vec3 sheet=mix(mix(hi,lo,g2),mix(dhi,dlo,g2),u_dark);
    sheet+=mix(.10,.05,u_dark)*exp(-max(y,0.)*26.);
    col=mix(col,sheet,on);
  }
  col+=(rand(gl_FragCoord.xy)-.5)*.012;
  gl_FragColor=vec4(col,1.);
}`;

const still = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

export function mountWall(host: HTMLElement, start = 14): Wall {
  const none: Wall = { setDark() {}, press() {}, release() {} };
  const canvas = document.createElement("canvas");
  const gl = canvas.getContext("webgl", { alpha: false, antialias: false, powerPreference: "low-power" });
  if (!gl) return none;
  const program = gl.createProgram()!;
  for (const [type, source] of [[gl.VERTEX_SHADER, VERT], [gl.FRAGMENT_SHADER, FRAG]] as const) {
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    gl.attachShader(program, shader);
  }
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return none;
  gl.useProgram(program);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const at = gl.getAttribLocation(program, "a");
  gl.enableVertexAttribArray(at);
  gl.vertexAttribPointer(at, 2, gl.FLOAT, false, 0, 0);
  const u = (name: string) => gl.getUniformLocation(program, name);
  const uRes = u("u_res");
  const uT = u("u_t");
  const uDark = u("u_dark");
  const uP = u("u_p");
  host.append(canvas);

  let dark = 0;
  let time = start;
  // Where the swell is, where it is heading, and how strong.
  const p = { x: 0.5, y: 0.5, z: 0, tx: 0.5, ty: 0.5, tz: 0 };

  const paint = () => {
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.uniform2f(uRes, canvas.width, canvas.height);
    gl.uniform1f(uT, time);
    gl.uniform1f(uDark, dark);
    gl.uniform3f(uP, p.x, p.y, p.z);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };

  let visible = false;
  let frame = 0;
  let last = 0;
  const loop = (now: number) => {
    frame = requestAnimationFrame(loop);
    const busy = p.tz > 0 || p.z > 0.004;
    // The drift is slow enough that thirty frames a second are plenty; a swell gets them all.
    if (!busy && now - last < 32) return;
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    time += dt;
    const ease = 1 - Math.exp(-dt * 9);
    p.x += (p.tx - p.x) * ease;
    p.y += (p.ty - p.y) * ease;
    p.z += (p.tz - p.z) * (1 - Math.exp(-dt * 5));
    paint();
  };
  const wake = () => {
    const on = visible && !document.hidden && !still();
    if (on && !frame) {
      last = performance.now();
      frame = requestAnimationFrame(loop);
    } else if (!on && frame) {
      cancelAnimationFrame(frame);
      frame = 0;
    }
  };
  new IntersectionObserver(([entry]) => {
    visible = !!entry?.isIntersecting;
    wake();
  }).observe(host);
  document.addEventListener("visibilitychange", wake);
  new ResizeObserver(() => {
    const scale = Math.min(devicePixelRatio, 1.5) * 0.75;
    canvas.width = Math.max(2, Math.round(host.clientWidth * scale));
    canvas.height = Math.max(2, Math.round(host.clientHeight * scale));
    paint();
  }).observe(host);

  return {
    setDark(on) {
      dark = on ? 1 : 0;
      paint();
    },
    press(x, y) {
      if (still()) return;
      const r = host.getBoundingClientRect();
      p.tx = (x - r.left) / r.width;
      p.ty = 1 - (y - r.top) / r.height;
      if (p.z < 0.02) {
        p.x = p.tx;
        p.y = p.ty;
      }
      p.tz = 1;
    },
    release() {
      p.tz = 0;
    },
  };
}
