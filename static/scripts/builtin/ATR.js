indicator("ATR", { overlay: false });
plot(ta.atr(input.int("Length", 14, { min: 1 })), { title: "ATR", color: "#b71c1c" });
