import { createElement, createRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { Modal, resolveModalAnchorPlacement } from './ui';

describe('resolveModalAnchorPlacement', () => {
  it('chooses the roomier side when both sides are large', () => {
    expect(resolveModalAnchorPlacement(320, 480)).toEqual({
      placement: 'below',
      maxHeight: 480,
      takeover: false,
    });
  });

  it('chooses above when below is short and above is large', () => {
    expect(resolveModalAnchorPlacement(360, 160)).toEqual({
      placement: 'above',
      maxHeight: 360,
      takeover: false,
    });
  });

  it('chooses below when above is short and below is large', () => {
    expect(resolveModalAnchorPlacement(160, 360)).toEqual({
      placement: 'below',
      maxHeight: 360,
      takeover: false,
    });
  });

  it('caps an anchored panel to available space instead of imposing a 256px floor', () => {
    expect(resolveModalAnchorPlacement(140, 220)).toEqual({
      placement: 'below',
      maxHeight: 220,
      takeover: false,
    });
  });

  it('falls back to takeover when the roomier side is under twelve rem', () => {
    expect(resolveModalAnchorPlacement(170, 180)).toEqual({
      placement: 'below',
      maxHeight: 180,
      takeover: true,
    });
  });
});

describe('Modal', () => {
  it('keeps the same body wrapper element in takeover and anchored layouts', () => {
    const renderModal = (variant: 'takeover' | 'anchored') => renderToStaticMarkup(createElement(Modal, {
      open: true,
      onClose: vi.fn(),
      title: 'Stable dialog',
      variant,
      anchorRef: createRef<HTMLButtonElement>(),
      children: createElement('span', { 'data-modal-body-content': true }, 'Body'),
    }));

    const takeover = renderModal('takeover');
    const anchored = renderModal('anchored');

    expect(takeover).toContain(
      '</header><div><span data-modal-body-content="true">Body</span></div></section>',
    );
    expect(takeover).toContain(
      'class="cicada-modal-enter max-h-[94dvh] w-full overflow-y-auto rounded-t-md border border-line bg-surface shadow-[0_24px_64px_var(--elevation-shadow-color)] sm:max-w-lg sm:rounded-md"',
    );
    expect(takeover).toContain(
      '<header class="sticky top-0 z-10 flex items-start justify-between gap-5 border-b border-line bg-canvas/95 px-5 py-4 backdrop-blur sm:px-6">',
    );
    expect(anchored).toContain(
      '</header><div class="min-h-0 flex-1 overflow-y-auto"><span data-modal-body-content="true">Body</span></div></section>',
    );
  });
});
