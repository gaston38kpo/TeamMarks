# CoinPulse — Design System
> Source: https://designmd.ai/chef/coinpulse · License: MIT

Electric, dark-mode, real-time energy for the decentralized frontier.

CoinPulse is a high-intensity design system built for cryptocurrency trading platforms and DeFi applications. It thrives in permanent dark mode, using electric blues, vivid limes, and warm ambers to convey real-time market energy. Every element is optimized for data density, scanning speed, and split-second decision-making.

---

## Color Palette

| Token | Value | Usage |
|---|---|---|
| Primary | `#2563EB` | Electric Blue — CTAs, active states, links |
| Secondary | `#84CC16` | Lime — profit indicators, positive deltas |
| Tertiary | `#F59E0B` | Amber — warnings, pending states, alerts |
| Neutral | `#71717A` | Zinc — muted text, inactive elements |
| Background | `#09090B` | App background, root canvas |
| Surface | `#18181B` | Cards, panels, modals |
| Success | `#22C55E` | Profit, gains, confirmations |
| Warning | `#F59E0B` | Pending transactions, caution |
| Error | `#EF4444` | Loss, failed tx, negative delta |
| Info | `#2563EB` | Informational banners, links |

## Typography

| Role | Font | Size | Weight |
|---|---|---|---|
| Display | Space Mono | 32px | Bold |
| Headline | Space Mono | 24px | Bold |
| Subhead | DM Sans | 18px | SemiBold |
| Body Large | DM Sans | 16px | Regular |
| Body | DM Sans | 14px | Regular |
| Body Small | DM Sans | 13px | Regular |
| Caption | DM Sans | 12px | Medium |
| Overline | Space Mono | 11px | Bold |
| Code | Space Mono | 13px | Regular |

## Spacing

Base unit: **4px** — all spacing values are multiples of 4.

## Do's & Don'ts

### Do
- Use tabular/monospaced numerals for all financial figures so columns align perfectly.
- Animate status changes with brief color flashes — green pulse for active/online, red for errors.
- Maintain green-for-success and red-for-error consistency across every screen.
- Use blue glow shadows on interactive elements to reinforce the electric aesthetic.
- Provide real-time visual feedback (spinners, skeleton loaders) for every data fetch.

### Don't
- Use light mode — the entire system is designed for dark backgrounds only.
- Place more than one primary action per panel to avoid costly misclicks.
- Use decorative animations that compete with live status data for user attention.
- Use pure white text — use `#FAFAFA` for primary text.
