indicator("SuperTrend", { overlay: true });
const { line, direction } = ta.supertrend(input.float("Factor", 3, { step: 0.1 }), input.int("ATR Length", 10));
plot(line, { title: "SuperTrend", width: 2, colors: Array.from(direction, (d) => (d === 1 ? "#26a69a" : "#ef5350")) });
plotshape(map(direction, (d, i) => i > 0 && d === 1 && direction[i - 1] === -1), { shape: "arrowUp", location: "belowBar", color: "#26a69a", text: "Buy" });
plotshape(map(direction, (d, i) => i > 0 && d === -1 && direction[i - 1] === 1), { shape: "arrowDown", location: "aboveBar", color: "#ef5350", text: "Sell" });
alertcondition(map(direction, (d, i) => i > 0 && d !== direction[i - 1]), { title: "Trend change", message: "SuperTrend flipped" });
