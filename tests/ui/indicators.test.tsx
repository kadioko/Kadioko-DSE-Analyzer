// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BoRatioCell,
  ChangeCell,
  ConfidenceBadge,
  PressureSignalBadge,
  ScoreBar,
} from '@/components/market/indicators';
import { NO_DATA } from '@/lib/format';

/**
 * What these protect is the rendered promise, not the arithmetic.
 *
 * The analytics layer is careful to return null when it does not know
 * something. All of that is undone if a component turns the null into a 0, an
 * empty bar, or a red arrow. These tests sit on that boundary.
 */

afterEach(cleanup);

describe('BoRatioCell', () => {
  it('shows the ratio when the book has both sides', () => {
    render(<BoRatioCell ratio={3.14} state="NORMAL" />);
    expect(screen.getByText('3.14')).toBeTruthy();
  });

  it('shows a genuine zero as zero, because no bids is a real observation', () => {
    // NO_BID means the market said something: there is no demand at any price.
    render(<BoRatioCell ratio={0} state="NO_BID" />);
    expect(screen.getByText('0.00')).toBeTruthy();
    expect(screen.queryByText(NO_DATA)).toBeNull();
  });

  it('shows a dash, never a large number, when there are no offers', () => {
    // Dividing by zero offers is undefined, not infinite. A sentinel like
    // 999999 here would sort to the top of any "most demand" ranking.
    const { container } = render(<BoRatioCell ratio={null} state="NO_OFFER" />);
    expect(container.textContent).toContain(NO_DATA);
    expect(container.textContent).toMatch(/no offer/i);
    expect(container.textContent).not.toMatch(/\d/);
  });

  it('says the book is empty rather than implying a balanced one', () => {
    const { container } = render(<BoRatioCell ratio={null} state="EMPTY_BOOK" />);
    expect(container.textContent).toContain(NO_DATA);
    expect(container.textContent).toMatch(/no book/i);
  });

  it('explains every book state on hover', () => {
    // A dash with no explanation is mysterious; the reader should be able to
    // find out why without leaving the table.
    for (const state of ['NORMAL', 'NO_BID', 'NO_OFFER', 'EMPTY_BOOK'] as const) {
      const { container, unmount } = render(
        <BoRatioCell ratio={state === 'NORMAL' ? 1.2 : null} state={state} />,
      );
      const titled = container.querySelector('[title]');
      expect(titled?.getAttribute('title'), state).toBeTruthy();
      unmount();
    }
  });

  it('colours by which side of the book is heavier', () => {
    const heavy = render(<BoRatioCell ratio={3.14} state="NORMAL" />);
    expect(heavy.container.querySelector('.text-up-400')).toBeTruthy();
    cleanup();

    const light = render(<BoRatioCell ratio={0.5} state="NORMAL" />);
    expect(light.container.querySelector('.text-down-400')).toBeTruthy();
    cleanup();

    // The market's own balance point, not a round number.
    const level = render(<BoRatioCell ratio={1.0} state="NORMAL" />);
    expect(level.container.querySelector('.text-up-400')).toBeNull();
    expect(level.container.querySelector('.text-down-400')).toBeNull();
  });
});

describe('ScoreBar', () => {
  it('renders the score and a bar when there is one', () => {
    const { container } = render(<ScoreBar score={73} label="Opportunity" />);
    expect(container.textContent).toContain('73');
    expect(container.textContent).toContain('Opportunity');
  });

  it('omits the bar entirely when the score is unknown', () => {
    // An empty bar reads as "lowest possible", which is a different claim from
    // "not enough data to score this".
    const { container } = render(<ScoreBar score={null} label="Opportunity" />);
    expect(container.textContent).toContain(NO_DATA);

    const widths = [...container.querySelectorAll<HTMLElement>('[style]')].map(
      (el) => el.style.width,
    );
    expect(widths.filter(Boolean)).toHaveLength(0);
  });

  it('renders a zero score as a real zero, distinct from unknown', () => {
    const { container } = render(<ScoreBar score={0} label="Opportunity" />);
    expect(container.textContent).toContain('0');
    expect(container.textContent).not.toContain(NO_DATA);
  });
});

describe('ChangeCell', () => {
  it('signs the direction explicitly', () => {
    render(<ChangeCell value={4.52} />);
    expect(screen.getByText('+4.52%')).toBeTruthy();
    cleanup();

    render(<ChangeCell value={-3.96} />);
    expect(screen.getByText('-3.96%')).toBeTruthy();
  });

  it('shows a dash for an unknown change, not a flat zero', () => {
    // This is the case a gap in history produces. Rendering 0.00% would assert
    // the price did not move, which is not what is known.
    const { container } = render(<ChangeCell value={null} />);
    expect(container.textContent).toContain(NO_DATA);
    expect(container.textContent).not.toContain('0.00');
  });

  it('does not colour an unknown change as a fall', () => {
    const { container } = render(<ChangeCell value={null} />);
    expect(container.querySelector('.text-down-400')).toBeNull();
  });
});

describe('PressureSignalBadge', () => {
  it('labels every signal, including the absence of one', () => {
    const expected: Record<string, RegExp> = {
      STRONG_DEMAND: /strong demand/i,
      DEMAND: /demand/i,
      BALANCED: /balanced/i,
      SUPPLY: /supply/i,
      STRONG_SUPPLY: /strong supply/i,
      INSUFFICIENT_DATA: /insufficient data/i,
    };

    for (const [signal, pattern] of Object.entries(expected)) {
      const { container, unmount } = render(
        <PressureSignalBadge signal={signal as never} />,
      );
      expect(container.textContent, signal).toMatch(pattern);
      unmount();
    }
  });

  it('carries the caveat that pressure is not a buy signal', () => {
    // The single most likely misreading of the product, so it is attached to
    // the badge itself rather than left to the methodology page.
    const { container } = render(<PressureSignalBadge signal="STRONG_DEMAND" />);
    const title = container.querySelector('[title]')?.getAttribute('title') ?? '';
    expect(title).toMatch(/not investment advice|not a buy signal/i);
  });

  it('does not dress insufficient data as a balanced market', () => {
    const insufficient = render(<PressureSignalBadge signal="INSUFFICIENT_DATA" />);
    const insufficientHtml = insufficient.container.innerHTML;
    cleanup();

    const balanced = render(<PressureSignalBadge signal="BALANCED" />);
    expect(insufficientHtml).not.toBe(balanced.container.innerHTML);
  });
});

describe('ConfidenceBadge', () => {
  it('renders a score when coverage is known', () => {
    const { container } = render(<ConfidenceBadge score={80} />);
    expect(container.textContent).toMatch(/80/);
  });

  it('shows a dash when confidence itself could not be established', () => {
    const { container } = render(<ConfidenceBadge score={null} />);
    expect(container.textContent).toContain(NO_DATA);
  });
});
