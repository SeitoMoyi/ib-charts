indicator("Stochastic", { overlay: false, precision: 2 });
const { k, d } = ta.stoch(input.int("%K Length", 14), input.int("%K Smoothing", 1), input.int("%D Smoothing", 3));
plot(k, { title: "%K", color: "#2962ff" });
plot(d, { title: "%D", color: "#ff6d00" });
hline(80); hline(20);
