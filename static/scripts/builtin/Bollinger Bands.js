indicator("Bollinger Bands", { overlay: true });
const src = input.source("Source", "close");
const len = input.int("Length", 20, { min: 1 });
const mult = input.float("StdDev", 2, { min: 0.1, step: 0.1 });
const { basis, upper, lower } = ta.bb(src, len, mult);
plot(basis, { title: "Basis", color: "#ff9800", width: 1 });
plot(upper, { title: "Upper", color: "#2962ff", width: 1 });
plot(lower, { title: "Lower", color: "#2962ff", width: 1 });
