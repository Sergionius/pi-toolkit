type Token = { value: string; operator: boolean };

/** A conservative heuristic, not a shell parser or a sandbox. */
export function looksMutating(command: string): boolean {
  const tokens: Token[] = [];
  let word = "", quote = "", inWord = false;
  const flush = () => { if (inWord) tokens.push({ value: word, operator: false }); word = ""; inWord = false; };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (ch === "\\" && quote !== "'") { word += command[++i] ?? ""; inWord = true; continue; }
    if (quote) { if (ch === quote) quote = ""; else word += ch; inWord = true; continue; }
    if (ch === "'" || ch === '"') { quote = ch; inWord = true; continue; }
    if (ch === "`" || (ch === "$" && command[i + 1] === "(")) return true;
    if (ch === "#" && !inWord) { while (i < command.length && command[i] !== "\n") i++; flush(); tokens.push({value:";",operator:true}); continue; }
    if (/[;|&<>\n]/.test(ch)) { flush(); tokens.push({ value: ch, operator: true }); continue; }
    if (/\s/.test(ch)) flush(); else { word += ch; inWord = true; }
  }
  if (quote) return true;
  flush();
  for (let i = 0; i < tokens.length; i++) {
    if (!tokens[i].operator || tokens[i].value !== ">") continue;
    let j = i + 1;
    if (tokens[j]?.value === ">" && tokens[j].operator) j++;
    if (tokens[j]?.value === "&" && tokens[j].operator && /^\d+$/.test(tokens[j + 1]?.value ?? "")) continue;
    if (tokens[j]?.value !== "/dev/null") return true;
  }
  const segments: string[][] = [[]];
  for (const token of tokens) {
    if (token.operator && /[;|&\n]/.test(token.value)) segments.push([]);
    else if (!token.operator) segments.at(-1)!.push(token.value);
  }
  return segments.some((words) => {
    while (words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]) || ["sudo", "env", "command", "builtin", "time"].includes(words[0]))) words.shift();
    if (["npx", "pnpx"].includes(words[0])) { words.shift(); while (words[0]?.startsWith("-")) words.shift(); }
    const name = (words.shift() ?? "").split("/").at(-1)!;
    if (["bash", "sh", "zsh"].includes(name)) {
      const index = words.findIndex((word) => /^-[^-]*c/.test(word));
      if (index >= 0) return looksMutating(words[index + 1] ?? "");
    }
    if (["rm", "mv", "cp", "chmod", "chown", "mkdir", "touch", "dd", "tee", "truncate", "install", "eval"].includes(name)) return true;
    if (name === "git") return words.some((word) => /^(commit|push|merge|rebase|reset|checkout|switch|restore|add|rm|clean|init|apply|am|cherry-pick|revert)$/.test(word));
    if (["npm", "pnpm", "yarn", "bun"].includes(name)) return words.some((word) => /^(i|install|ci|add|remove|uninstall|update|upgrade|format)$/.test(word));
    if (/^pip\d*$/.test(name) || (name.startsWith("python") && words[0] === "-m" && /^pip\d*$/.test(words[1] ?? ""))) return words.some((word) => /^(install|uninstall)$/.test(word));
    if (name === "sed") return words.some((word) => /^-[^-]*i/.test(word) || /^--in-place(?:=|$)/.test(word));
    if (name === "curl") return words.some((word) => /^-[^-]*[oO]/.test(word) || /^--(?:output|remote-name)(?:=|$)/.test(word));
    if (["prettier", "eslint"].includes(name)) return words.some((word) => /^--(?:write|fix)(?:=|$)/.test(word));
    if (["cargo", "go", "dart"].includes(name) && ["fmt", "format"].includes(words[0])) return true;
    return ["terraform", "kubectl"].includes(name) && words.includes("apply");
  });
}
