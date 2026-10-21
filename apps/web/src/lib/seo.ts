import type { Metadata } from 'next';

const DEFAULT_SITE_URL = 'https://2api.hub';
const BRAND_NAME = '2API Hub';

function siteOrigin(value: string): string {
  try {
    const url = new URL(value.trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return DEFAULT_SITE_URL;
    return url.origin;
  } catch {
    return DEFAULT_SITE_URL;
  }
}

export const SITE_URL = siteOrigin(process.env.HUB_SITE_URL ?? process.env.NEXT_PUBLIC_SITE_URL ?? DEFAULT_SITE_URL);

export function absoluteUrl(path: string): string {
  const url = new URL(path.startsWith('/') ? path : `/${path}`, `${SITE_URL}/`);
  if (url.origin !== SITE_URL) throw new Error('站内 URL 不能指向其它站点。');
  return url.toString();
}

export function pageMetadata({ title, description, path, noIndex = false, imagePath = '/opengraph-image' }: {
  title: string;
  description: string;
  path: string;
  noIndex?: boolean;
  imagePath?: string;
}): Metadata {
  const fullTitle = /2api\s*hub/i.test(title) ? title : `${title} · ${BRAND_NAME}`;
  const canonical = new URL(absoluteUrl(path));
  canonical.search = '';
  canonical.hash = '';
  const image = { url: absoluteUrl(imagePath), width: 1200, height: 630, alt: fullTitle };

  return {
    title: { absolute: fullTitle },
    description,
    alternates: { canonical: canonical.toString() },
    openGraph: {
      type: 'website',
      locale: 'zh_CN',
      siteName: BRAND_NAME,
      title: fullTitle,
      description,
      url: canonical.toString(),
      images: [image],
    },
    twitter: { card: 'summary_large_image', title: fullTitle, description, images: [image] },
    ...(noIndex ? { robots: { index: false, follow: false } } : {}),
  };
}
