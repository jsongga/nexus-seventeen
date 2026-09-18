/** Boots the React task-board application into the page's root element with development safeguards enabled. */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BoardApp } from "./BoardApp";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BoardApp />
  </StrictMode>
);
