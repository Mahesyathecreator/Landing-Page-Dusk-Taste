const { useEffect, useRef, forwardRef, useImperativeHandle, useLayoutEffect, useMemo, Children, isValidElement } = React;

const INHERIT = /^(currentcolor|inherit)$/i;
const TONES = 12;
const FADES = 8;
const HEAT_RANGE = 36;
const HEAT_DEADZONE = 3;
const TAU = Math.PI * 2;
const REST_ANGLE = -Math.PI / 4;
const BURST_SPRING = 18;
const BURST_DAMPING = 7.5;
const SCAN_FADE = [0, 0.12, 0.42, 0.78, 1, 0.78, 0.42, 0.12, 0];
const FADE_FLOOR = { gather: 0, rain: 0.55, spiral: 0.45, scan: 0.35 };

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const easeOutCubic = t => 1 - Math.pow(1 - t, 3);
const easeInFall = t => Math.pow(t, 1.7);
const easeInOutCubic = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const fadeAlpha = level => 0.35 + (0.65 * level) / (FADES - 1);
const wrapHalfTurn = angle => (((angle % Math.PI) + Math.PI * 1.5) % Math.PI) - Math.PI / 2;

const resolveFontSize = (value, container, fontWeight, fontFamily) => {
  if (typeof value === 'number') return value;
  const probe = document.createElement('span');
  probe.textContent = 'M';
  probe.style.position = 'absolute';
  probe.style.visibility = 'hidden';
  probe.style.pointerEvents = 'none';
  probe.style.fontSize = value;
  probe.style.fontWeight = String(fontWeight);
  probe.style.fontFamily = fontFamily;
  container.appendChild(probe);
  const size = parseFloat(window.getComputedStyle(probe).fontSize) || 96;
  probe.remove();
  return size;
};

const waitForFonts = async font => {
  if (!('fonts' in document)) return;
  try { await document.fonts.load(font); } catch {}
  await document.fonts.ready;
};

const ParticleText = ({
  text = 'React Bits', particleSize = 2, density = 4, color = 'currentColor',
  highlightColor = '#ff5a36', highlightMode = 'motion', shape = 'circle',
  intro = 'gather', scatter = 180, gatherDuration = 1600, stagger = 420,
  clickBurst = true, burstStrength = 1, pointerRepel = 40, repelRadius = 120,
  idleDrift = 0.7, trigger = 'mount', fontSize = 'clamp(3rem, 12vw, 8rem)',
  fontWeight = 800, fontFamily = 'inherit', glow = true, className = '', style
}) => {
  const containerRef = useRef(null);
  const canvasRef = useRef(null);
  const settingsRef = useRef(null);
  const wakeRef = useRef(() => {});

  useEffect(() => {
    settingsRef.current = { text, particleSize, density, color, highlightColor, highlightMode, shape, intro, scatter, gatherDuration, stagger, clickBurst, burstStrength, pointerRepel, repelRadius, idleDrift, trigger, fontSize, fontWeight, fontFamily, glow };
    wakeRef.current();
  });

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    const layer = document.createElement('canvas');
    const layerCtx = layer.getContext('2d');
    const probe = document.createElement('canvas');
    probe.width = 1; probe.height = 1;
    const probeCtx = probe.getContext('2d', { willReadFrequently: true });
    if (!container || !canvas || !ctx || !layerCtx || !probeCtx) return undefined;

    const motionQuery = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    let reducedMotion = !!motionQuery?.matches;
    let particles = []; let raf = 0; let sampleFrame = 0; let buildId = 0;
    let introPending = true; let sampledKey = ''; let sampledText = ''; let requestedSize = '';
    let gathering = false; let gatherStart = 0; let introMode = 'gather'; let bursting = false;
    let width = 0; let height = 0; let dpr = 1; let last = 0; let visible = true; let alive = true;
    let colorKey = ''; let palette = []; let glowColor = '#000000';
    let accent = { r: 0, g: 0, b: 0 };
    const bounds = { left: 0, right: 0, top: 0, bottom: 0 };
    const swirl = { x: 0, y: 0, aspect: 1 };
    const scan = { from: 0, to: 0, top: 0, bottom: 0, duration: 1 };
    const buckets = Array.from({ length: TONES * FADES }, () => []);
    const pointer = { active: false, x: 0, y: 0, smoothX: 0, smoothY: 0 };

    const family = s => !s.fontFamily || s.fontFamily === 'inherit' ? window.getComputedStyle(container).fontFamily || 'sans-serif' : s.fontFamily;
    const layoutKey = s => [s.text, s.fontSize, s.fontWeight, family(s), s.density].join('|');
    const sizeKey = () => {
      const rect = container.getBoundingClientRect();
      return `${Math.floor(rect.width)}x${Math.floor(rect.height)}@${Math.min(window.devicePixelRatio || 1, 2)}`;
    };

    const toRgb = value => {
      probeCtx.clearRect(0, 0, 1, 1);
      probeCtx.fillStyle = '#000000';
      probeCtx.fillStyle = value;
      probeCtx.fillRect(0, 0, 1, 1);
      const [r, g, b] = probeCtx.getImageData(0, 0, 1, 1).data;
      return { r, g, b };
    };

    const ensureColors = s => {
      const current = window.getComputedStyle(container).color || '#000000';
      const pick = value => (!value || INHERIT.test(String(value).trim()) ? current : value);
      const base = pick(s.color);
      const highlight = pick(s.highlightColor);
      const key = `${base}|${highlight}`;
      if (key === colorKey) return;
      colorKey = key;
      const from = toRgb(base);
      accent = toRgb(highlight);
      glowColor = `rgb(${accent.r}, ${accent.g}, ${accent.b})`;
      palette = Array.from({ length: TONES }, (_, i) => {
        const t = i / (TONES - 1);
        return `rgb(${Math.round(from.r + (accent.r - from.r) * t)}, ${Math.round(from.g + (accent.g - from.g) * t)}, ${Math.round(from.b + (accent.b - from.b) * t)})`;
      });
    };

    const travelTime = (s, particle) => {
      if (reducedMotion) return 1;
      if (introMode === 'scan') return s.gatherDuration * 0.4;
      if (introMode === 'rain') return s.gatherDuration * (0.45 + particle.depth * 0.3);
      return s.gatherDuration;
    };

    const startIntro = initial => {
      const s = settingsRef.current;
      if (!particles.length || !s) return;
      introMode = s.intro;
      const spread = reducedMotion ? 0 : s.scatter;
      const tall = Math.max(1, bounds.bottom - bounds.top);
      swirl.x = (bounds.left + bounds.right) / 2;
      swirl.y = (bounds.top + bounds.bottom) / 2;
      swirl.aspect = clamp(width / Math.max(1, height), 1, 2.5);
      scan.from = bounds.left - 24; scan.to = bounds.right + 24;
      scan.top = bounds.top - tall * 0.3; scan.bottom = bounds.bottom + tall * 0.3;
      scan.duration = Math.max(200, s.gatherDuration * 0.8);
      let reach = 1;

      if (introMode === 'spiral') {
        for (const particle of particles) {
          const dx = particle.targetX - swirl.x;
          const dy = (particle.targetY - swirl.y) * swirl.aspect;
          particle.radius = Math.hypot(dx, dy);
          particle.heading = Math.atan2(dy, dx);
          reach = Math.max(reach, particle.radius);
        }
      }

      for (const particle of particles) {
        let delay = particle.seed * s.stagger;
        let startX; let startY;

        if (introMode === 'rain') {
          startX = particle.targetX + (particle.depth - 0.9) * 16;
          startY = -12 - particle.depth * 30 - particle.seed * height * 0.22;
          delay = particle.seed * s.stagger * 1.3;
        } else if (introMode === 'spiral') {
          particle.startRadius = particle.radius * (1.04 + particle.depth * 0.22) + spread * 0.3 * particle.seed;
          particle.swirl = (1.5 + 2.6 * (1 - particle.radius / reach)) * (0.85 + particle.seed * 0.3);
          const angle = particle.heading + particle.swirl;
          startX = swirl.x + Math.cos(angle) * particle.startRadius;
          startY = swirl.y + (Math.sin(angle) * particle.startRadius) / swirl.aspect;
          delay = particle.seed * s.stagger;
        } else if (introMode === 'scan') {
          const along = (particle.targetX - scan.from) / Math.max(1, scan.to - scan.from);
          startX = particle.targetX + 3 + particle.seed * 8;
          startY = scan.top + ((particle.seed * 7.31 + particle.depth * 3.7) % 1) * (scan.bottom - scan.top);
          delay = along * scan.duration + particle.seed * s.stagger * 0.15;
        } else {
          const angle = particle.seed * TAU;
          const distance = spread * (0.35 + particle.depth * 0.75);
          startX = particle.targetX + Math.cos(angle) * distance + (particle.seed - 0.5) * spread * 0.45;
          startY = particle.targetY + Math.sin(angle) * distance + (particle.depth - 0.9) * spread * 0.45;
        }

        particle.startX = startX; particle.startY = startY;
        particle.delay = reducedMotion ? 0 : delay;
        if (initial) { particle.x = startX; particle.y = startY; }
      }
      gatherStart = performance.now(); gathering = true; wake();
    };

    const burst = (x, y) => {
      const s = settingsRef.current;
      if (!s || !particles.length) return;
      const strength = Math.max(0, Number(s.burstStrength) || 0);
      if (!strength) return;
      const radius = 90 + 70 * Math.sqrt(strength) + s.repelRadius * 0.25;
      for (const particle of particles) {
        const dx = particle.x - x; const dy = particle.y - y;
        const distance = Math.hypot(dx, dy);
        if (distance > radius) continue;
        const falloff = 1 - distance / radius;
        const power = 950 * strength * (0.2 + 0.8 * falloff * falloff) * (0.65 + particle.depth * 0.45);
        const angle = Math.atan2(dy, dx) + (particle.seed - 0.5) * 0.9;
        particle.vx += Math.cos(angle) * power;
        particle.vy += Math.sin(angle) * power;
      }
      bursting = true; wake();
    };

    const drawGroup = (target, group, base, shape) => {
      target.beginPath();
      if (shape === 'line') {
        for (const particle of group) {
          const dx = Math.cos(particle.angle) * particle.length * 0.5;
          const dy = Math.sin(particle.angle) * particle.length * 0.5;
          target.moveTo(particle.x - dx, particle.y - dy);
          target.lineTo(particle.x + dx, particle.y + dy);
        }
        target.stroke(); return;
      }
      const square = shape === 'square';
      for (const particle of group) {
        const size = square ? base : Math.max(0.6, base * (0.75 + particle.weight * 0.45));
        if (square || size <= 2.1) {
          target.rect(particle.x - size / 2, particle.y - size / 2, size, size);
        } else {
          target.moveTo(particle.x + size / 2, particle.y);
          target.arc(particle.x, particle.y, size / 2, 0, TAU);
        }
      }
      target.fill();
    };

    const drawScan = (now, s) => {
      const progress = (now - gatherStart) / scan.duration;
      if (introMode !== 'scan' || progress < 0 || progress > 1.3 || reducedMotion) return false;
      const x = scan.from + (scan.to - scan.from) * clamp(progress, 0, 1);
      const alpha = clamp(progress / 0.08, 0, 1) * clamp((1.3 - progress) / 0.3, 0, 1);
      const gradient = ctx.createLinearGradient(0, scan.top, 0, scan.bottom);
      SCAN_FADE.forEach((level, i) => {
        gradient.addColorStop(i / (SCAN_FADE.length - 1), `rgba(${accent.r}, ${accent.g}, ${accent.b}, ${level})`);
      });
      ctx.globalAlpha = alpha * 0.85;
      ctx.fillStyle = gradient;
      if (s.glow) { ctx.shadowColor = glowColor; ctx.shadowBlur = 8 * dpr; }
      ctx.fillRect(x - 0.75, scan.top, 1.5, scan.bottom - scan.top);
      ctx.shadowBlur = 0; ctx.shadowColor = 'transparent'; ctx.globalAlpha = 1;
      return true;
    };

    const step = now => {
      const s = settingsRef.current;
      if (!s) return false;
      const dt = last ? Math.min(0.05, Math.max(0, (now - last) / 1000)) : 1 / 60;
      last = now; ensureColors(s);
      const frames = Math.max(dt * 60, 0.001);
      const follow = reducedMotion ? 1 : 1 - Math.pow(0.78, frames);
      const chase = 1 - Math.pow(0.82, frames);
      const turn = 1 - Math.pow(0.72, frames);
      pointer.smoothX += (pointer.x - pointer.smoothX) * chase;
      pointer.smoothY += (pointer.y - pointer.smoothY) * chase;

      const repel = pointer.active && !reducedMotion && s.pointerRepel > 0 && s.repelRadius > 0;
      const drift = !reducedMotion && s.idleDrift > 0;
      const motionHeat = s.highlightMode !== 'gradient';
      const lines = s.shape === 'line';
      const floor = gathering ? (FADE_FLOOR[introMode] ?? 0) : 0;
      const time = now * 0.001;
      const sizeBase = Math.max(0.1, Number(s.particleSize) || 0);
      const restLength = Math.max(2, sizeBase * 0.8 + Math.max(2, Math.floor(Number(s.density) || 0)) * 0.7);
      let complete = true; let moving = false; let settling = false;

      for (const bucket of buckets) bucket.length = 0;

      for (const particle of particles) {
        let baseX = particle.targetX; let baseY = particle.targetY;
        let progress = 1; let hidden = false;

        if (gathering) {
          const local = (now - gatherStart - particle.delay) / Math.max(1, travelTime(s, particle));
          progress = clamp(local, 0, 1);
          if (introMode === 'scan' && local < 0) hidden = true;
          if (introMode === 'spiral') {
            const eased = easeInOutCubic(progress);
            const radius = particle.startRadius + (particle.radius - particle.startRadius) * eased;
            const angle = particle.heading + particle.swirl * (1 - eased);
            baseX = swirl.x + Math.cos(angle) * radius;
            baseY = swirl.y + (Math.sin(angle) * radius) / swirl.aspect;
          } else {
            const eased = introMode === 'rain' ? easeInFall(progress) : easeOutCubic(progress);
            baseX = particle.startX + (particle.targetX - particle.startX) * eased;
            baseY = particle.startY + (particle.targetY - particle.startY) * eased;
          }
          if (progress < 1) complete = false;
        } else if (drift) {
          baseX += Math.sin(time * 0.9 + particle.seed * 10) * s.idleDrift * particle.depth;
          baseY += Math.cos(time * 0.75 + particle.depth * 10) * s.idleDrift * particle.depth;
        }

        if (bursting) {
          particle.vx += (-BURST_SPRING * particle.ox - BURST_DAMPING * particle.vx) * dt;
          particle.vy += (-BURST_SPRING * particle.oy - BURST_DAMPING * particle.vy) * dt;
          particle.ox += particle.vx * dt; particle.oy += particle.vy * dt;
          if (Math.abs(particle.ox) + Math.abs(particle.oy) > 0.05 || Math.abs(particle.vx) + Math.abs(particle.vy) > 1) {
            settling = true;
          } else { particle.ox = 0; particle.oy = 0; particle.vx = 0; particle.vy = 0; }
          baseX += particle.ox; baseY += particle.oy;
        }

        if (repel) {
          const dx = baseX - pointer.smoothX; const dy = baseY - pointer.smoothY;
          const distance = Math.hypot(dx, dy);
          if (distance > 0 && distance < s.repelRadius) {
            const force = Math.pow(1 - distance / s.repelRadius, 2) * s.pointerRepel;
            baseX += (dx / distance) * force; baseY += (dy / distance) * force;
          }
        }

        const moveX = (baseX - particle.x) * follow;
        const moveY = (baseY - particle.y) * follow;
        particle.x += moveX; particle.y += moveY;
        if (Math.abs(moveX) + Math.abs(moveY) > 0.02) moving = true;

        if (lines) {
          const speed = Math.hypot(moveX, moveY) / frames;
          const aim = speed > 0.3 ? Math.atan2(moveY, moveX) : REST_ANGLE;
          const offset = wrapHalfTurn(aim - particle.angle);
          particle.angle += offset * turn;
          if (Math.abs(offset) > 0.01) moving = true;
          particle.length = restLength + Math.min(restLength * 4, speed * 1.6);
        }

        if (hidden) continue;

        const heat = motionHeat ? clamp((Math.hypot(particle.x - particle.targetX, particle.y - particle.targetY) - HEAT_DEADZONE) / HEAT_RANGE, 0, 1) : particle.tone;
        const tone = Math.round(heat * (TONES - 1));
        const fade = Math.round((floor + (1 - floor) * progress) * (FADES - 1));
        buckets[fade * TONES + tone].push(particle);
      }

      if (gathering && complete) gathering = false;
      if (bursting && !settling) bursting = false;

      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const strokeWidth = Math.max(1, sizeBase * 0.65);
      if (lines) { ctx.lineWidth = strokeWidth; ctx.lineCap = 'round'; }

      if (s.glow) {
        layerCtx.setTransform(1, 0, 0, 1, 0, 0);
        layerCtx.clearRect(0, 0, layer.width, layer.height);
        layerCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
        layerCtx.fillStyle = glowColor; layerCtx.strokeStyle = glowColor;
        layerCtx.lineWidth = strokeWidth; layerCtx.lineCap = 'round';
        let lit = false;
        for (let fade = 0; fade < FADES; fade++) {
          for (let tone = 1; tone < TONES; tone++) {
            const group = buckets[fade * TONES + tone];
            if (!group.length) continue;
            layerCtx.globalAlpha = (tone / (TONES - 1)) * fadeAlpha(fade);
            drawGroup(layerCtx, group, sizeBase, s.shape);
            lit = true;
          }
        }
        layerCtx.globalAlpha = 1;
        if (lit) {
          ctx.shadowColor = glowColor;
          ctx.shadowBlur = (3 + sizeBase * 1.5) * dpr;
          ctx.drawImage(layer, 0, 0, width, height);
          ctx.shadowBlur = 0; ctx.shadowColor = 'transparent';
        }
      }

      for (let fade = 0; fade < FADES; fade++) {
        ctx.globalAlpha = fadeAlpha(fade);
        for (let tone = 0; tone < TONES; tone++) {
          const group = buckets[fade * TONES + tone];
          if (!group.length) continue;
          if (lines) ctx.strokeStyle = palette[tone];
          else ctx.fillStyle = palette[tone];
          drawGroup(ctx, group, sizeBase, s.shape);
        }
      }
      ctx.globalAlpha = 1;
      const scanning = drawScan(now, s);
      return gathering || moving || repel || drift || bursting || scanning;
    };

    const frame = now => {
      raf = 0; if (!alive) return;
      const s = settingsRef.current;
      if (s) {
        const key = layoutKey(s);
        if (key !== sampledKey) { queueSample(s.text !== sampledText); sampledKey = key; sampledText = s.text; }
      }
      const busy = step(now);
      if (busy && visible && alive) raf = requestAnimationFrame(frame);
    };

    function wake() {
      if (raf || !visible || !alive) return;
      last = 0; raf = requestAnimationFrame(frame);
    }
    wakeRef.current = wake;

    const sampleText = async () => {
      const s = settingsRef.current;
      if (!s) return;
      const currentBuild = ++buildId;
      const rect = container.getBoundingClientRect();
      const nextWidth = Math.floor(rect.width);
      const nextHeight = Math.floor(rect.height);
      requestedSize = sizeKey(); sampledKey = layoutKey(s); sampledText = s.text;
      if (nextWidth <= 0 || nextHeight <= 0) return;

      const nextDpr = Math.min(window.devicePixelRatio || 1, 2);
      const resolvedFamily = family(s);
      let resolvedSize = resolveFontSize(s.fontSize, container, s.fontWeight, resolvedFamily);
      let font = `${s.fontWeight} ${resolvedSize}px ${resolvedFamily}`;
      await waitForFonts(font);
      if (currentBuild !== buildId || !alive) return;

      const offscreen = document.createElement('canvas');
      const offCtx = offscreen.getContext('2d', { willReadFrequently: true });
      if (!offCtx) return;

      const content = String(s.text || ' ');
      const maxTextWidth = nextWidth * 0.92;
      offCtx.font = font;
      let metrics = offCtx.measureText(content);
      const measuredWidth = Math.max(1, metrics.width);
      if (measuredWidth > maxTextWidth) {
        resolvedSize = Math.max(18, resolvedSize * (maxTextWidth / measuredWidth));
        font = `${s.fontWeight} ${resolvedSize}px ${resolvedFamily}`;
        await waitForFonts(font);
        if (currentBuild !== buildId || !alive) return;
        offCtx.font = font; metrics = offCtx.measureText(content);
      }

      const left = Math.ceil(metrics.actualBoundingBoxLeft || 0);
      const right = Math.ceil(metrics.actualBoundingBoxRight || metrics.width);
      const ascent = Math.ceil(metrics.actualBoundingBoxAscent || resolvedSize * 0.78);
      const descent = Math.ceil(metrics.actualBoundingBoxDescent || resolvedSize * 0.22);
      const padding = Math.max(12, Math.ceil(resolvedSize * 0.08));
      const textWidth = Math.max(1, left + right);
      const textHeight = Math.max(1, ascent + descent);

      offscreen.width = textWidth + padding * 2;
      offscreen.height = textHeight + padding * 2;
      offCtx.clearRect(0, 0, offscreen.width, offscreen.height);
      offCtx.font = font; offCtx.textAlign = 'left'; offCtx.textBaseline = 'alphabetic';
      offCtx.fillStyle = '#ffffff';
      offCtx.fillText(content, padding - left, padding + ascent);

      const imageData = offCtx.getImageData(0, 0, offscreen.width, offscreen.height);
      const targets = [];
      const sampleStep = Math.max(2, Math.floor(s.density));

      for (let y = 0; y < offscreen.height; y += sampleStep) {
        for (let x = 0; x < offscreen.width; x += sampleStep) {
          const alpha = imageData.data[(y * offscreen.width + x) * 4 + 3];
          if (alpha > 40) {
            targets.push({ x: x - padding, y: nextHeight / 2 - offscreen.height / 2 + y, alpha: alpha / 255 });
          }
        }
      }

      const maxParticles = Math.max(900, Math.min(5200, Math.floor((nextWidth * nextHeight) / 90)));
      const stride = Math.max(1, Math.ceil(targets.length / maxParticles));
      const selected = targets.filter((_, index) => index % stride === 0);
      const intro = introPending && !reducedMotion;
      introPending = false;

      width = nextWidth; height = nextHeight; dpr = nextDpr;
      canvas.width = Math.max(1, Math.floor(width * dpr));
      canvas.height = Math.max(1, Math.floor(height * dpr));
      layer.width = canvas.width; layer.height = canvas.height;

      bounds.left = Infinity; bounds.right = -Infinity; bounds.top = Infinity; bounds.bottom = -Infinity;
      for (const target of selected) {
        bounds.left = Math.min(bounds.left, target.x);
        bounds.right = Math.max(bounds.right, target.x);
        bounds.top = Math.min(bounds.top, target.y);
        bounds.bottom = Math.max(bounds.bottom, target.y);
      }
      if (!selected.length) { bounds.left = bounds.right = width / 2; bounds.top = bounds.bottom = height / 2; }

      particles = selected.map((target, index) => {
        const seed = ((index * 9301 + 49297) % 233280) / 233280;
        const depth = 0.45 + (((index * 233 + 97) % 1000) / 1000) * 0.9;
        return { x: target.x, y: target.y, startX: target.x, startY: target.y, targetX: target.x, targetY: target.y, weight: target.alpha, tone: clamp(target.x / Math.max(1, width) + (seed - 0.5) * 0.35, 0, 1), seed, depth, delay: 0, ox: 0, oy: 0, vx: 0, vy: 0, angle: REST_ANGLE, length: 0, radius: 0, heading: 0, startRadius: 0, swirl: 0 };
      });
      bursting = false;

      if (!pointer.active) { pointer.x = width / 2; pointer.y = height / 2; pointer.smoothX = pointer.x; pointer.smoothY = pointer.y; }
      if (intro) { startIntro(true); } else { gathering = false; }
      step(performance.now()); wake();
    };

    function queueSample(intro) {
      if (intro) introPending = true;
      if (sampleFrame) cancelAnimationFrame(sampleFrame);
      sampleFrame = requestAnimationFrame(() => { sampleFrame = 0; sampleText(); });
    }

    const locate = event => {
      const rect = canvas.getBoundingClientRect();
      pointer.x = event.clientX - rect.left; pointer.y = event.clientY - rect.top;
    };

    const handlePointerMove = event => {
      locate(event);
      if (!pointer.active) { pointer.smoothX = pointer.x; pointer.smoothY = pointer.y; }
      pointer.active = true; wake();
    };
    const handlePointerLeave = () => { pointer.active = false; wake(); };
    const handlePointerEnter = event => {
      handlePointerMove(event);
      if (settingsRef.current?.trigger === 'hover') startIntro(false);
    };
    const handlePointerDown = event => {
      const s = settingsRef.current;
      if (!s || s.trigger === 'click' || !s.clickBurst || reducedMotion) return;
      const rect = canvas.getBoundingClientRect();
      burst(event.clientX - rect.left, event.clientY - rect.top);
    };
    const handleClick = () => { if (settingsRef.current?.trigger === 'click') startIntro(false); };

    const handleReduceMotionChange = event => {
      reducedMotion = event.matches;
      if (reducedMotion) {
        gathering = false; bursting = false;
        particles.forEach(particle => { particle.x = particle.targetX; particle.y = particle.targetY; particle.ox = 0; particle.oy = 0; particle.vx = 0; particle.vy = 0; });
      }
      wake();
    };

    motionQuery?.addEventListener?.('change', handleReduceMotionChange);
    canvas.addEventListener('pointerenter', handlePointerEnter);
    canvas.addEventListener('pointermove', handlePointerMove);
    canvas.addEventListener('pointerleave', handlePointerLeave);
    canvas.addEventListener('pointerdown', handlePointerDown);
    canvas.addEventListener('click', handleClick);

    const resizeObserver = new ResizeObserver(() => { if (sizeKey() !== requestedSize) queueSample(false); });
    resizeObserver.observe(container);
    const intersectionObserver = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; wake(); });
    intersectionObserver.observe(container);
    const themeObserver = new MutationObserver(wake);
    for (const node of [document.documentElement, document.body]) {
      if (node) themeObserver.observe(node, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });
    }
    const schemeQuery = window.matchMedia?.('(prefers-color-scheme: dark)');
    schemeQuery?.addEventListener?.('change', wake);

    sampleText();

    return () => {
      alive = false; buildId += 1; wakeRef.current = () => {};
      resizeObserver.disconnect(); intersectionObserver.disconnect(); themeObserver.disconnect();
      schemeQuery?.removeEventListener?.('change', wake);
      motionQuery?.removeEventListener?.('change', handleReduceMotionChange);
      canvas.removeEventListener('pointerenter', handlePointerEnter);
      canvas.removeEventListener('pointermove', handlePointerMove);
      canvas.removeEventListener('pointerleave', handlePointerLeave);
      canvas.removeEventListener('pointerdown', handlePointerDown);
      canvas.removeEventListener('click', handleClick);
      if (raf) cancelAnimationFrame(raf);
      if (sampleFrame) cancelAnimationFrame(sampleFrame);
    };
  }, []);

  return (
    <div ref={containerRef} className={`particle-text ${className}`.trim()} style={style}>
      <canvas ref={canvasRef} className="particle-text__canvas" aria-hidden="true" />
      <span className="particle-text__sr">{text}</span>
    </div>
  );
};

const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

const PERSPECTIVE = 900;
const TAU_CS = Math.PI * 2;
const STEP_CS = 1 / 240;
const PAD_CS = 32;
const AXES_CS = ['x', 'y', 'z', 'r', 'p'];
const DOWN_CS = { x: 0, y: 1 };

const clampCS = (value, min, max) => Math.min(max, Math.max(min, value));

const stackBounds = ({ width, height, cardDistance, verticalDistance, depth, skewAmount, visible, hoverSpread }) => {
  const slope = Math.tan((skewAmount * Math.PI) / 180);
  const spread = 1 + Math.max(0, hoverSpread);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < visible; i++) {
    const scale = PERSPECTIVE / (PERSPECTIVE + i * depth);
    for (const u of [-width / 2, width / 2]) {
      for (const v of [-height / 2, height / 2]) {
        const x = (i * cardDistance * spread + u) * scale;
        const y = (-i * verticalDistance * spread + v + u * slope) * scale;
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      }
    }
  }
  return { width: Math.ceil(maxX - minX + PAD_CS * 2), height: Math.ceil(maxY - minY + PAD_CS * 2), originX: PAD_CS - minX, originY: PAD_CS - minY };
};

const Card = forwardRef(({ customClass, className, children, ...rest }, ref) => (
  <div ref={ref} {...rest} className={['card-swap-card', customClass, className].filter(Boolean).join(' ')}>
    {children}
    <span className="card-swap-card-rim" aria-hidden="true" />
  </div>
));
Card.displayName = 'Card';

const ItemCard = ({ item }) => (
  <Card>
    <div className="card-swap-item">
      {(item.icon || item.title) && (
        <div className="card-swap-head">
          {item.icon && <span className="card-swap-icon">{item.icon}</span>}
          {item.title && <span className="card-swap-title">{item.title}</span>}
        </div>
      )}
      {item.image && (
        <div className="card-swap-media">
          <img src={item.image} alt={item.alt ?? item.title ?? ''} draggable={false} />
        </div>
      )}
    </div>
  </Card>
);

const CardSwap = forwardRef(
  ({ items, width = 460, height = 340, cardDistance = 60, verticalDistance = 70, depth = 90, skewAmount = 6, visibleCards = 4, delay = 4000, autoplay = true, pauseOnHover = true, draggable = true, speed = 1, bounce = 0.35, parallax = 0.5, hoverSpread = 0.12, dim = 0.5, cardRadius = 18, intro = true, onCardClick, onChange, className = '', children }, ref) => {
    const rootRef = useRef(null);
    const stageRef = useRef(null);
    const slotRefs = useRef([]);
    const shadeRefs = useRef([]);
    const apiRef = useRef(null);
    const settingsRef = useRef(null);

    const cards = useMemo(() => {
      const custom = Children.toArray(children).filter(isValidElement);
      if (custom.length) return custom;
      return (items?.length ? items : []).map((item, index) => (
        <ItemCard key={`${item.title ?? 'card'}-${index}`} item={item} />
      ));
    }, [children, items]);
    
    const count = cards.length;
    const cardWidth = Math.max(40, Number(width) || 460);
    const cardHeight = Math.max(40, Number(height) || 340);
    const visible = clampCS(Math.round(visibleCards), 1, Math.max(1, count));

    const bounds = useMemo(() => stackBounds({ width: cardWidth, height: cardHeight, cardDistance, verticalDistance, depth: Math.max(0, depth), skewAmount, visible, hoverSpread }), [cardWidth, cardHeight, cardDistance, verticalDistance, depth, skewAmount, visible, hoverSpread]);

    settingsRef.current = { width: cardWidth, height: cardHeight, dx: cardDistance, dy: verticalDistance, dz: Math.max(0, depth), skew: skewAmount, visible, delay, autoplay, pauseOnHover, draggable, speed: clampCS(speed, 0.1, 4), bounce: clampCS(bounce, 0, 1), parallax: clampCS(parallax, 0, 1), hoverSpread: Math.max(0, hoverSpread), dim: clampCS(dim, 0, 1), bounds, onCardClick, onChange };

    useImperativeHandle(ref, () => ({ next: () => apiRef.current?.next(), prev: () => apiRef.current?.prev() }), []);

    useIsomorphicLayoutEffect(() => {
      const root = rootRef.current;
      const stage = stageRef.current;
      if (!root || !stage || !count) return undefined;
      const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
      const now = performance.now();
      const s0 = settingsRef.current;

      const deck = Array.from({ length: count }, (_, index) => ({ el: slotRefs.current[index], shade: shadeRefs.current[index], index, pos: index, from: index, hold: 0, nudge: 0, phase: 'rest', dir: { x: 0, y: 1 }, tilt: 0, top: 0, under: false, x: 0, y: 0, z: 0, r: 0, p: 0, v: { x: 0, y: 0, z: 0, r: 0, p: 0 } }));
      const state = { order: deck.map(card => card.index), raf: 0, last: 0, timer: 0, queue: [], layers: 0, scale: 1, hovered: false, overCard: false, inView: true, drag: null, spread: 0, spreadV: 0, px: 0, py: 0, pvx: 0, pvy: 0, tx: 0, ty: 0, dragged: false, autoplay: s0.autoplay, delay: s0.delay };

      const slot = (position, s) => {
        const q = Math.min(position, s.visible);
        const spread = 1 + state.spread;
        return { x: q * s.dx * spread, y: -q * s.dy * spread, z: -q * s.dz, r: 0, p: q };
      };

      const clearance = (s, dir) => Math.abs(dir.x) * s.width + Math.abs(dir.y) * s.height + 12;
      const targetOf = (card, s, time) => {
        if (card.phase === 'exit') {
          const base = slot(0, s); const reach = clearance(s, card.dir) * 1.3;
          return { x: base.x + card.dir.x * reach, y: base.y + card.dir.y * reach, z: base.z, r: card.tilt, p: 0 };
        }
        if (card.phase === 'enter') {
          const base = slot(0, s);
          return { x: base.x, y: base.y + clearance(s, DOWN_CS) * 1.3, z: base.z, r: 0, p: card.p };
        }
        const position = (time < card.hold ? card.from : card.pos) + card.nudge;
        return slot(Math.max(0, position), s);
      };

      const layerOf = card => { if (card.top) return 1000 + card.top; if (card.under) return 1; return 10 + (count - card.pos) * 2; };

      const write = (card, s) => {
        const { el, shade } = card; if (!el) return;
        el.style.transform = `translate3d(${card.x.toFixed(2)}px, ${card.y.toFixed(2)}px, ${card.z.toFixed(2)}px) rotate(${card.r.toFixed(3)}deg) skewY(${s.skew}deg)`;
        el.style.zIndex = String(layerOf(card));
        const fade = clampCS(s.visible - card.p, 0, 1);
        el.style.opacity = fade < 1 ? fade.toFixed(3) : '';
        el.style.visibility = fade <= 0.001 ? 'hidden' : '';
        if (shade) { const depthT = clampCS(card.p / Math.max(1, s.visible - 1), 0, 1); shade.style.opacity = (s.dim * 0.62 * depthT).toFixed(3); }
        el.style.cursor = card.phase === 'drag' ? 'grabbing' : card.pos > 0 ? 'pointer' : s.draggable ? 'grab' : '';
        if (card.pos === 0) el.setAttribute('data-front', ''); else el.removeAttribute('data-front');
      };

      const writeStage = s => {
        const ox = s.bounds.originX + state.px; const oy = s.bounds.originY + state.py;
        stage.style.perspectiveOrigin = `${ox.toFixed(2)}px ${oy.toFixed(2)}px`;
      };

      const integrate = (card, target, omega, zeta, dt) => {
        const k = omega * omega; const d = 2 * zeta * omega;
        const steps = Math.max(1, Math.ceil(dt / STEP_CS)); const h = dt / steps;
        for (let i = 0; i < steps; i++) {
          for (const axis of AXES_CS) {
            const velocity = card.v[axis] + (k * (target[axis] - card[axis]) - d * card.v[axis]) * h;
            card.v[axis] = velocity; card[axis] += velocity * h;
          }
        }
      };

      const scalar = (value, velocity, target, omega, zeta, dt) => {
        const k = omega * omega; const d = 2 * zeta * omega;
        const steps = Math.max(1, Math.ceil(dt / STEP_CS)); const h = dt / steps;
        let x = value; let v = velocity;
        for (let i = 0; i < steps; i++) { v += (k * (target - x) - d * v) * h; x += v * h; }
        return [x, v];
      };

      const frame = time => {
        state.raf = 0; const s = settingsRef.current;
        const dt = state.last ? Math.min(0.05, (time - state.last) / 1000) : 1 / 60;
        state.last = time; const speed = s.speed;
        const restOmega = TAU_CS * 1.7 * speed; const restZeta = reduce ? 1 : 1 - 0.72 * s.bounce;
        const exitOmega = TAU_CS * 1.9 * speed; let busy = false;

        const spreadTarget = state.hovered && !reduce ? s.hoverSpread : 0;
        [state.spread, state.spreadV] = scalar(state.spread, state.spreadV, spreadTarget, TAU_CS * 1.4, 0.9, dt);
        [state.px, state.pvx] = scalar(state.px, state.pvx, reduce ? 0 : state.tx, TAU_CS * 1.1, 1, dt);
        [state.py, state.pvy] = scalar(state.py, state.pvy, reduce ? 0 : state.ty, TAU_CS * 1.1, 1, dt);
        if (Math.abs(state.spread - spreadTarget) > 0.0005 || Math.abs(state.spreadV) > 0.0005 || Math.abs(state.px - state.tx) > 0.05 || Math.abs(state.py - state.ty) > 0.05 || Math.abs(state.pvx) + Math.abs(state.pvy) > 0.05) busy = true;
        writeStage(s);

        for (const card of deck) {
          if (card.phase === 'drag') { busy = true; write(card, s); continue; }
          const target = targetOf(card, s, time);
          const moving = card.phase === 'exit' || card.phase === 'enter';
          integrate(card, target, moving ? exitOmega : restOmega, moving ? 1 : restZeta, dt);
          if (card.phase === 'exit') {
            const base = slot(0, s); const travelled = (card.x - base.x) * card.dir.x + (card.y - base.y) * card.dir.y;
            if (travelled >= clearance(s, card.dir)) { card.phase = 'rest'; card.top = 0; card.hold = 0; }
          } else if (card.phase === 'enter') {
            const base = slot(0, s);
            if (card.y - base.y >= clearance(s, DOWN_CS)) { card.phase = 'rest'; card.under = false; card.hold = 0; }
          }
          if (card.hold > time || card.phase !== 'rest') busy = true;
          for (const axis of AXES_CS) { const limit = axis === 'p' ? 0.001 : 0.02; if (Math.abs(target[axis] - card[axis]) > limit || Math.abs(card.v[axis]) > limit) busy = true; }
          write(card, s);
        }

        if (busy) state.raf = requestAnimationFrame(frame);
        else { state.last = 0; for (const card of deck) { if (card.top && card.phase === 'rest') card.top = 0; } }
      };

      const wake = () => { if (!state.raf) state.raf = requestAnimationFrame(frame); };
      const paused = () => { const s = settingsRef.current; return !s.autoplay || count < 2 || (s.pauseOnHover && state.overCard) || state.drag || !state.inView || document.visibilityState === 'hidden'; };

      const schedule = () => {
        clearTimeout(state.timer); state.timer = 0;
        if (paused()) return;
        state.timer = window.setTimeout(() => { state.timer = 0; shift(1); }, Math.max(400, settingsRef.current.delay));
      };

      const settleOrder = (time, stagger) => {
        state.order.forEach((index, position) => {
          const card = deck[index]; if (card.pos === position) return;
          card.from = card.pos; card.pos = position; card.hold = time + Math.max(0, position) * stagger;
        });
      };

      const shift = (direction, options = {}) => {
        if (count < 2) return; const s = settingsRef.current; const time = performance.now();
        const stagger = 0.05 / s.speed;
        if (direction > 0) {
          const front = deck[state.order[0]];
          state.order = [...state.order.slice(1), front.index];
          settleOrder(time, stagger * 1000);
          front.phase = 'exit'; front.dir = options.dir ?? DOWN_CS; front.tilt = options.tilt ?? 0;
          front.top = ++state.layers; front.under = false; front.nudge = 0; front.hold = 0;
          if (options.velocity) { front.v.x = options.velocity.x; front.v.y = options.velocity.y; }
        } else {
          const back = deck[state.order[count - 1]];
          state.order = [back.index, ...state.order.slice(0, count - 1)];
          settleOrder(time, stagger * 1000);
          back.phase = 'enter'; back.top = 0; back.under = true; back.nudge = 0; back.hold = 0;
        }
        deck.forEach(card => { if (card.phase === 'rest') card.nudge = 0; });
        s.onChange?.(state.order[0]); wake(); schedule();
      };

      const goTo = position => {
        state.queue.forEach(clearTimeout); state.queue = [];
        const gap = 110 / settingsRef.current.speed;
        for (let i = 0; i < position; i++) state.queue.push(window.setTimeout(() => shift(1), i * gap));
      };

      const fit = () => {
        const s = settingsRef.current; const w = root.clientWidth; const h = root.clientHeight;
        const scale = Math.min(1, w / s.bounds.width, h > 0 ? h / s.bounds.height : 1);
        state.scale = scale > 0 ? scale : 1;
        stage.style.transform = `translate(-50%, -50%) scale(${state.scale.toFixed(4)})`;
      };

      const local = event => { const box = root.getBoundingClientRect(); return { x: event.clientX - box.left, y: event.clientY - box.top, w: box.width, h: box.height }; };

      const onMove = event => {
        const s = settingsRef.current;
        if (event.pointerType !== 'touch') {
          const point = local(event);
          const nx = clampCS((point.x / Math.max(1, point.w)) * 2 - 1, -1, 1);
          const ny = clampCS((point.y / Math.max(1, point.h)) * 2 - 1, -1, 1);
          state.tx = nx * s.parallax * 0.35 * s.bounds.width;
          state.ty = ny * s.parallax * 0.35 * s.bounds.height;
          state.hovered = true;
          const overCard = Boolean(event.target.closest?.('[data-swap-index]'));
          if (overCard !== state.overCard) { state.overCard = overCard; schedule(); }
          wake();
        }
        const drag = state.drag; if (!drag || drag.id !== event.pointerId) return;
        const dx = (event.clientX - drag.startX) / state.scale;
        const dy = (event.clientY - drag.startY) / state.scale;
        if (!drag.active) {
          if (Math.hypot(dx, dy) < 5) return;
          drag.active = true; state.dragged = true;
          const card = deck[drag.index]; card.phase = 'drag'; card.v = { x: 0, y: 0, z: 0, r: 0, p: 0 };
          root.setPointerCapture?.(event.pointerId); root.style.cursor = 'grabbing';
        }
        const card = deck[drag.index]; const base = slot(0, s);
        card.x = base.x + dx; card.y = base.y + dy; card.z = base.z;
        card.r = clampCS(dx * 0.035, -9, 9); card.p = 0;
        const time = performance.now();
        drag.samples.push({ x: card.x, y: card.y, t: time });
        while (drag.samples.length > 2 && time - drag.samples[0].t > 90) drag.samples.shift();
        const progress = clampCS(Math.hypot(dx, dy) / (Math.min(s.width, s.height) * 0.3), 0, 1);
        const next = deck[state.order[1]];
        if (next && next.phase === 'rest') next.nudge = -0.22 * progress;
        wake();
      };

      const onLeave = event => {
        if (event.pointerType === 'touch') return; if (state.drag?.active) return;
        state.hovered = false; state.overCard = false; state.tx = 0; state.ty = 0;
        schedule(); wake();
      };

      const onDown = event => {
        const s = settingsRef.current; state.dragged = false;
        if (!s.draggable || event.button > 0 || count < 2) return;
        const target = event.target.closest?.('[data-swap-index]');
        if (!target || !root.contains(target)) return;
        const index = Number(target.getAttribute('data-swap-index'));
        if (index !== state.order[0] || deck[index].phase !== 'rest') return;
        state.drag = { id: event.pointerId, index, startX: event.clientX, startY: event.clientY, active: false, samples: [] };
        schedule();
      };

      const onUp = event => {
        const drag = state.drag; if (!drag || drag.id !== event.pointerId) return;
        state.drag = null; root.style.cursor = '';
        if (!drag.active) { schedule(); return; }
        root.releasePointerCapture?.(event.pointerId);
        const s = settingsRef.current; const card = deck[drag.index];
        const base = slot(0, s);
        const first = drag.samples[0]; const lastSample = drag.samples[drag.samples.length - 1];
        const span = first && lastSample ? Math.max(0.016, (lastSample.t - first.t) / 1000) : 1;
        const velocity = first && lastSample && lastSample !== first ? { x: (lastSample.x - first.x) / span, y: (lastSample.y - first.y) / span } : { x: 0, y: 0 };
        const offset = { x: card.x - base.x, y: card.y - base.y };
        const distance = Math.hypot(offset.x, offset.y);
        const fling = Math.hypot(velocity.x, velocity.y);
        const next = deck[state.order[1]]; if (next) next.nudge = 0;
        if (event.type !== 'pointercancel' && (distance > Math.min(s.width, s.height) * 0.3 || fling > 700)) {
          const aim = { x: offset.x + velocity.x * 0.12, y: offset.y + velocity.y * 0.12 };
          const length = Math.hypot(aim.x, aim.y) || 1;
          card.phase = 'rest';
          shift(1, { dir: { x: aim.x / length, y: aim.y / length }, tilt: card.r, velocity });
        } else {
          card.phase = 'rest'; card.v.x = velocity.x; card.v.y = velocity.y; wake(); schedule();
        }
      };

      const onClick = event => {
        if (state.dragged) { state.dragged = false; return; }
        const target = event.target.closest?.('[data-swap-index]');
        if (!target || !root.contains(target)) return;
        const index = Number(target.getAttribute('data-swap-index'));
        settingsRef.current.onCardClick?.(index);
        const position = state.order.indexOf(index);
        if (position > 0) goTo(position);
      };

      const onVisibility = () => schedule();

      apiRef.current = {
        next: () => shift(1), prev: () => shift(-1),
        refresh: () => {
          const s = settingsRef.current;
          deck.forEach(card => {
            const el = slotRefs.current[card.index]; const shade = shadeRefs.current[card.index];
            if (el === card.el && shade === card.shade) return;
            card.el = el; card.shade = shade; write(card, s);
          });
          if (s.autoplay !== state.autoplay || s.delay !== state.delay) { state.autoplay = s.autoplay; state.delay = s.delay; schedule(); }
          fit(); wake();
        }
      };

      if (intro && !reduce) {
        deck.forEach(card => { card.from = 0; card.hold = now + (card.pos * 70) / s0.speed; });
        stage.animate?.([{ opacity: 0 }, { opacity: 1 }], { duration: 420, easing: 'ease-out' });
      } else {
        deck.forEach(card => { Object.assign(card, slot(card.pos, s0)); });
      }
      fit(); writeStage(s0); deck.forEach(card => write(card, s0)); wake();

      const resizeObserver = new ResizeObserver(fit);
      resizeObserver.observe(root);
      const intersectionObserver = new IntersectionObserver(entries => { state.inView = entries[entries.length - 1]?.isIntersecting ?? true; schedule(); });
      intersectionObserver.observe(root);
      root.addEventListener('pointermove', onMove);
      root.addEventListener('pointerleave', onLeave);
      root.addEventListener('pointerdown', onDown);
      root.addEventListener('pointerup', onUp);
      root.addEventListener('pointercancel', onUp);
      root.addEventListener('click', onClick);
      document.addEventListener('visibilitychange', onVisibility);
      schedule();

      return () => {
        cancelAnimationFrame(state.raf); clearTimeout(state.timer);
        state.queue.forEach(clearTimeout);
        resizeObserver.disconnect(); intersectionObserver.disconnect();
        root.removeEventListener('pointermove', onMove);
        root.removeEventListener('pointerleave', onLeave);
        root.removeEventListener('pointerdown', onDown);
        root.removeEventListener('pointerup', onUp);
        root.removeEventListener('pointercancel', onUp);
        root.removeEventListener('click', onClick);
        document.removeEventListener('visibilitychange', onVisibility);
        apiRef.current = null;
      };
    }, [count]);

    useIsomorphicLayoutEffect(() => { apiRef.current?.refresh(); });

    const onKeyDown = event => {
      if (event.key === 'ArrowRight' || event.key === 'ArrowDown') { event.preventDefault(); apiRef.current?.next(); }
      else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') { event.preventDefault(); apiRef.current?.prev(); }
    };

    const rootStyle = {
      '--swap-w': `${cardWidth}px`, '--swap-h': `${cardHeight}px`,
      '--swap-ox': `${bounds.originX}px`, '--swap-oy': `${bounds.originY}px`,
      '--swap-stage-w': `${bounds.width}px`, '--swap-stage-h': `${bounds.height}px`,
      '--swap-ratio': `${bounds.width} / ${bounds.height}`, '--swap-radius': `${Math.max(0, cardRadius)}px`
    };

    return (
      <div ref={rootRef} className={`card-swap${className ? ` ${className}` : ''}`} style={rootStyle} tabIndex={0} role="region" aria-roledescription="carousel" aria-label="Card stack" onKeyDown={onKeyDown}>
        <div className="card-swap-sizer" aria-hidden="true"><span></span></div>
        <div ref={stageRef} className="card-swap-stage">
          {cards.map((card, index) => (
            <div key={index} ref={node => { slotRefs.current[index] = node; }} className="card-swap-slot" data-swap-index={index}>
              {card}
              <span ref={node => { shadeRefs.current[index] = node; }} className="card-swap-shade" aria-hidden="true" />
            </div>
          ))}
        </div>
      </div>
    );
  }
);
CardSwap.displayName = 'CardSwap';

const HeroText = () => (
  <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'flex-start' }}>
    <ParticleText
      text="Desserts."
      particleSize={3.2} density={4} color="#693616" highlightColor="#f20e0efe"
      highlightMode="motion" shape="circle" intro="gather" scatter={130}
      gatherDuration={1600} stagger={425} clickBurst={true} burstStrength={1}
      pointerRepel={42} repelRadius={120} idleDrift={0.8} trigger="mount"
      fontSize="clamp(3rem, 9vw, 6rem)" fontWeight={80}
      fontFamily="'Bricolage Grotesque', sans-serif" glow={true}
    />
  </div>
);
ReactDOM.createRoot(document.getElementById('hero-particle-text')).render(<HeroText />);

const ShopCardSwap = () => {
  const items = [
    { 
      title: 'Cocktails', 
      image: 'https://z-cdn.chatglm.cn/image-search-mcp/images-ppt/a8cb5be9c3e5.jpg',
      icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8h1a4 4 0 0 1 0 8h-1"/><path d="M2 8h16v9a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4Z"/><line x1="6" x2="6" y1="2" y2="4"/><line x1="10" x2="10" y1="2" y2="4"/><line x1="14" x2="14" y1="2" y2="4"/></svg>
    },
    { 
      title: 'Desserts', 
      image: 'https://z-cdn.chatglm.cn/image-search-mcp/images-ppt/1f6aa29f7121.jpg',
      icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v6M12 22v-6M2 12h6M22 12h-6"/><circle cx="12" cy="12" r="4"/></svg>
    },
    { 
      title: 'Matcha', 
      image: 'https://z-cdn.chatglm.cn/image-search-mcp/images-ppt/061a438d2ca4.jpg',
      icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12V8H6a2 2 0 0 1 0-4h12v4"/><path d="M6 12v8a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-8"/><circle cx="16" cy="16" r="1"/></svg>
    },
    { 
      title: 'Traditional', 
      image: 'https://z-cdn.chatglm.cn/image-search-mcp/images-ppt/294576bea6d0.jpg',
      icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0Z"/><circle cx="12" cy="10" r="3"/></svg>
    }
  ];

  return (
    <CardSwap 
      items={items} 
      width={460} 
      height={340} 
      delay={4000} 
      cardDistance={60} 
      verticalDistance={70} 
      depth={90} 
      skewAmount={6} 
      visibleCards={4} 
      cardRadius={18} 
      speed={1} 
      bounce={0.35} 
      parallax={0.5} 
      hoverSpread={0.12} 
      dim={0.5} 
      autoplay={true} 
      pauseOnHover={true} 
      draggable={true}
    />
  );
};
ReactDOM.createRoot(document.getElementById('shop-card-swap')).render(<ShopCardSwap />);

const toggle = document.querySelector('.nav-toggle');
const menu = document.querySelector('.mobile-menu');
const closeBtn = document.querySelector('.mobile-close');

toggle?.addEventListener('click', () => menu.classList.add('open'));
closeBtn?.addEventListener('click', () => menu.classList.remove('open'));
menu?.querySelectorAll('a').forEach(a =>
  a.addEventListener('click', () => menu.classList.remove('open'))
);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') menu?.classList.remove('open');
});

const groups = new Map();
document.querySelectorAll('[data-reveal]').forEach(el => {
  const g = el.dataset.reveal;
  if (!groups.has(g)) groups.set(g, []);
  groups.get(g).push(el);
});

const observer = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      const g = entry.target.dataset.reveal;
      const siblings = groups.get(g) || [];
      const idx = siblings.indexOf(entry.target);
      entry.target.style.transitionDelay = (Math.min(idx, 5) * 0.07) + 's';
      entry.target.classList.add('in-view');
      observer.unobserve(entry.target);
    }
  });
}, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });

document.querySelectorAll('[data-reveal]').forEach(el => observer.observe(el));

document.querySelectorAll('a[href^="#"]').forEach(link => {
  link.addEventListener('click', (e) => {
    const id = link.getAttribute('href');
    if (id.length > 1) {
      const target = document.querySelector(id);
      if (target) {
        e.preventDefault();
        const top = target.getBoundingClientRect().top + window.scrollY - 80;
        window.scrollTo({ top, behavior: 'smooth' });
      }
    }
  });
});