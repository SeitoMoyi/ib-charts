indicator("RSI", { overlay: false, precision: 2 });
const src = input.source("Source", "close");
const len = input.int("Length", 14, { min: 1 });
plot(ta.rsi(src, len), { title: "RSI", color: "#7e57c2", width: 1.5 });
hline(input.int("Overbought", 70), { color: "#787b86" });
hline(input.int("Oversold", 30), { color: "#787b86" });
