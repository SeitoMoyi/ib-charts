indicator("MACD", { overlay: false });
const src = input.source("Source", "close");
const { macd, signal, hist } = ta.macd(src, input.int("Fast", 12), input.int("Slow", 26), input.int("Signal", 9));
plot(hist, {
  title: "Histogram", style: "histogram",
  colors: Array.from(hist, (h, i) => (h >= 0 ? (h >= hist[i - 1] ? "#26a69a" : "#b2dfdb") : (h <= hist[i - 1] ? "#ef5350" : "#ffcdd2"))),
});
plot(macd, { title: "MACD", color: "#2962ff" });
plot(signal, { title: "Signal", color: "#ff6d00" });
hline(0, { color: "#787b86", dash: 2 });
