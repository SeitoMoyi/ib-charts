// Example strategy-style indicator: arrows where a fast EMA crosses a slow EMA,
// plus alert conditions you can turn into alerts.
indicator("EMA Cross", { overlay: true });
const fast = ta.ema(close, input.int("Fast", 9, { min: 1 }));
const slow = ta.ema(close, input.int("Slow", 21, { min: 1 }));
plot(fast, { title: "Fast", color: "#2196f3" });
plot(slow, { title: "Slow", color: "#ff9800" });
const up = ta.crossover(fast, slow), down = ta.crossunder(fast, slow);
plotshape(up, { shape: "arrowUp", location: "belowBar", color: "#26a69a" });
plotshape(down, { shape: "arrowDown", location: "aboveBar", color: "#ef5350" });
alertcondition(up, { title: "Bullish cross", message: "Fast EMA crossed above slow EMA" });
alertcondition(down, { title: "Bearish cross", message: "Fast EMA crossed below slow EMA" });
