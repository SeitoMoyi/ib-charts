// Session VWAP: resets every day. Needs volume (not available for forex / indices).
indicator("VWAP", { overlay: true });
plot(ta.vwap(hlc3), { title: "VWAP", color: input.color("Color", "#ff9800"), width: 1.5 });
