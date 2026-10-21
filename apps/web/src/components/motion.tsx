'use client';

import {useRef} from 'react';
import type {ReactNode} from 'react';
import gsap from 'gsap';
import {ScrollTrigger} from 'gsap/ScrollTrigger';
import {useGSAP} from '@gsap/react';

gsap.registerPlugin(ScrollTrigger, useGSAP);

export function Motion({children}: {children: ReactNode}) {
  const root = useRef<HTMLDivElement>(null);

  useGSAP(() => {
    const mm = gsap.matchMedia();
    mm.add('(prefers-reduced-motion: no-preference)', () => {
      // Hero 在 SSR 和 hydration 前后始终可见，首页五组元素总时长为 0.61 秒。
      gsap.from('[data-hero-reveal]', {
        y: 8, duration: .45, stagger: .04, ease: 'power2.out', clearProps: 'transform',
      });
      gsap.utils.toArray<HTMLElement>('[data-reveal]').forEach(el => {
        gsap.from(el, {
          y: 30, opacity: 0, duration: .85, ease: 'power3.out',
          scrollTrigger: {trigger: el, start: 'top 92%', once: true},
        });
      });
      const words = root.current?.querySelectorAll('.scrub-copy span');
      if (words?.length) {
        gsap.fromTo(words, {opacity: .16}, {
          opacity: 1, stagger: .16, ease: 'none',
          scrollTrigger: {trigger: '.scrub-copy', start: 'top 85%', end: 'bottom 55%', scrub: 1},
        });
      }
    });
    mm.add('(min-width: 900px) and (prefers-reduced-motion: no-preference)', () => {
      if (root.current?.querySelector('.method-sticky')) {
        ScrollTrigger.create({
          trigger: '.method-section', start: 'top 150px', end: 'bottom 550px',
          pin: '.method-sticky', pinSpacing: false,
        });
      }
    });
    return () => mm.revert();
  }, {scope: root});

  return <div ref={root}>{children}</div>;
}
