import "./style.css";
import { ThomWidget } from "./app.js";

const root = document.getElementById("thom-root");
if (root) {
  const widget = new ThomWidget(root);
  void widget.mount();
}
