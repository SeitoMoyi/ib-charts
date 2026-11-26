indicator("ADX / DMI", { overlay: false, precision: 2 });
const { plus, minus, adx } = ta.dmi(input.int("DI Length", 14), input.int("ADX Smoothing", 14));
plot(adx, { title: "ADX", color: "#ff5252", width: 2 });
plot(plus, { title: "+DI", color: "#26a69a" });
plot(minus, { title: "-DI", color: "#ef5350" });
hline(25, { dash: 2 });
