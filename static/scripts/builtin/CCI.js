indicator("CCI", { overlay: false, precision: 2 });
plot(ta.cci(input.int("Length", 20)), { title: "CCI", color: "#2962ff" });
hline(100); hline(-100); hline(0, { dash: 2 });
