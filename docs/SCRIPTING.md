# Writing indicators

Click **</> Script editor** in the toolbar (or **ƒx Indicators → + New script…**).
Scripts are plain JavaScript in a Pine-like style.
- **Where they're saved:** as `.js` files in the `scripts/` folder of your data directory.
- **Using your own editor:** you can edit the files in any editor, and charts using a script update as soon as you save it.

```js
indicator("EMA Cross", { overlay: true });

const fast = ta.ema(close, input.int("Fast", 9, { min: 1 }));
const slow = ta.ema(close, input.int("Slow", 21, { min: 1 }));

plot(fast, { title: "Fast", color: "#2196f3" });
plot(slow, { title: "Slow", color: "#ff9800" });

plotshape(ta.crossover(fast, slow), { shape: "arrowUp", location: "belowBar", color: "#26a69a" });
plotshape(ta.crossunder(fast, slow), { shape: "arrowDown", location: "aboveBar", color: "#ef5350" });
alertcondition(ta.crossover(fast, slow), { title: "Bullish cross" });
```

## How scripts work

- **Series are arrays.** Every series (`close`, the result of `ta.ema`, …) is an array with one value per bar, oldest first.
  - `n` is the number of bars.
  - Bars that don't have a value yet are `NaN`, for example the first 20 bars of a 20-period average.
- **Whole history in one pass.** A script runs once over all loaded bars. It runs again (at most every 0.75 s) as live bars update.
- **Sandboxed.** Scripts run in a sandbox: a separate worker with **no network access**. They are stopped if they take longer than 3 seconds.

## Declaring

| Function | |
|---|---|
| `indicator(title, { overlay, precision })` | `overlay: true` draws on the price chart; otherwise the script gets its own panel. |
| `input.int(title, default, { min, max, step })` | Shows up in the ⚙ settings dialog. Also: `input.float`, `input.bool`, `input.color`, `input.string(title, default, { options })`. |
| `input.source(title, "close")` | Lets the user pick open/high/low/close/hl2/hlc3/ohlc4; returns that series. |

## Data

`open high low close volume time hl2 hlc3 ohlc4 n`. `time` is in seconds, shifted to your local time zone.

## Output

| Function | |
|---|---|
| `plot(series, { title, color, width, style, colors })` | `style`: `line`, `step`, `histogram`, `area`, `circles`. `colors`: an array with one colour per bar. |
| `hline(price, { title, color, dash })` | Horizontal level; `dash` is 0 solid, 1 dashed, 2 dotted. |
| `plotshape(condition, { shape, location, color, text })` | Marker on every bar where `condition` is true. `shape`: `arrowUp`, `arrowDown`, `circle`, `square`. `location`: `aboveBar`, `belowBar`, `inBar`. |
| `bgcolor(condition, color)` / `bgcolor(colors)` | Background colour per bar. |
| `alertcondition(condition, { title, message })` | Makes the condition available to alerts. |

## `ta.*`

`sma ema rma wma hma vwma rsi stdev highest lowest change mom roc cum crossover crossunder cross`,
`macd(src, fast, slow, signal) → { macd, signal, hist }`, `bb(src, len, mult) → { basis, upper, lower }`,
`atr(len)`, `tr()`, `stoch(k, kSmooth, d) → { k, d }`, `vwap(src)`, `obv()`, `cci(len)`, `mfi(len)`,
`dmi(len, adxLen) → { plus, minus, adx }`, `supertrend(factor, atrLen) → { line, direction }`.

## Helpers

| | |
|---|---|
| `series(i => …)` | Build a series bar by bar. |
| `map(series, (v, i) => …)` | Transform a series. |
| `shift(series, k)` | The value `k` bars ago (Pine's `src[k]`). |
| `add sub mul div` | Element-wise maths on series and/or numbers. |
| `na(x)`, `nz(x, v)` | Missing-value helpers. |
| `color.rgba("#hex", alpha)` | Transparent colours. |

The built-in indicators are scripts too. Open one from **ƒx Indicators → Copy** to see how it's written.
