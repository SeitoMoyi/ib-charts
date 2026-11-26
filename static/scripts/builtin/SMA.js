indicator("SMA", { overlay: true });
const src = input.source("Source", "close");
const len = input.int("Length", 20, { min: 1 });
plot(ta.sma(src, len), { title: "SMA", color: input.color("Color", "#f7c948"), width: 1.5 });
