import React from "react";
import ReactDOM from "react-dom/client";
import "reactflow/dist/style.css";
import "./style.css";
import App from "./App";

const root = document.getElementById("root");
if (root === null) {
  throw new Error("apps/web: #root element not found");
}

ReactDOM.createRoot(root).render(<App />);
