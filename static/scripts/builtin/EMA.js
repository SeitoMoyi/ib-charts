indicator("EMA", { overlay: true });
const src = input.source("Source", "close");
const len = input.int("Length", 50, { min: 1 });
plot(ta.ema(src, len), { title: "EMA", color: input.color("Color", "#e040fb"), width: 1.5 });
