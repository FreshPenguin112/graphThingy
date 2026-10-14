export const MOBILE_KEYBOARD_CATEGORIES = Object.freeze([
  "Greek", "Arithmetic", "Relations", "Sets & Logic", "Arrows",
  "Calculus & Operators", "Delimiters", "Accents", "Miscellaneous",
]);

const source = String.raw`
Greek|alpha|α|\alpha|lowercase alpha
Greek|beta|β|\beta|lowercase beta
Greek|gamma|γ|\gamma|lowercase gamma
Greek|delta|δ|\delta|lowercase delta
Greek|epsilon|ε|\epsilon|lowercase epsilon
Greek|variant epsilon|ϵ|\varepsilon|varepsilon lunate epsilon
Greek|zeta|ζ|\zeta|lowercase zeta
Greek|eta|η|\eta|lowercase eta
Greek|theta|θ|\theta|lowercase theta
Greek|variant theta|ϑ|\vartheta|vartheta
Greek|iota|ι|\iota|lowercase iota
Greek|kappa|κ|\kappa|lowercase kappa
Greek|variant kappa|ϰ|\varkappa|varkappa
Greek|lambda|λ|\lambda|lowercase lambda
Greek|mu|μ|\mu|lowercase mu
Greek|nu|ν|\nu|lowercase nu
Greek|xi|ξ|\xi|lowercase xi
Greek|omicron|ο|o|lowercase omicron
Greek|pi|π|\pi|lowercase pi
Greek|variant pi|ϖ|\varpi|varpi
Greek|rho|ρ|\rho|lowercase rho
Greek|variant rho|ϱ|\varrho|varrho
Greek|sigma|σ|\sigma|lowercase sigma
Greek|final sigma|ς|\varsigma|varsigma
Greek|tau|τ|\tau|lowercase tau
Greek|upsilon|υ|\upsilon|lowercase upsilon
Greek|phi|ϕ|\phi|lowercase phi
Greek|variant phi|φ|\varphi|varphi
Greek|chi|χ|\chi|lowercase chi
Greek|psi|ψ|\psi|lowercase psi
Greek|omega|ω|\omega|lowercase omega
Greek|capital Gamma|Γ|\Gamma|uppercase gamma
Greek|capital Delta|Δ|\Delta|uppercase delta
Greek|capital Theta|Θ|\Theta|uppercase theta
Greek|capital Lambda|Λ|\Lambda|uppercase lambda
Greek|capital Xi|Ξ|\Xi|uppercase xi
Greek|capital Pi|Π|\Pi|uppercase pi
Greek|capital Sigma|Σ|\Sigma|uppercase sigma
Greek|capital Upsilon|Υ|\Upsilon|uppercase upsilon
Greek|capital Phi|Φ|\Phi|uppercase phi
Greek|capital Psi|Ψ|\Psi|uppercase psi
Greek|capital Omega|Ω|\Omega|uppercase omega
Arithmetic|plus minus|±|\pm|plus-or-minus
Arithmetic|minus plus|∓|\mp|minus-or-plus
Arithmetic|times|×|\times|multiply multiplication
Arithmetic|dot product|⋅|\cdot|centered dot scalar product
Arithmetic|division|÷|\div|divide
Arithmetic|star operator|⋆|\star|star convolution
Arithmetic|circled plus|⊕|\oplus|direct sum xor
Arithmetic|circled times|⊗|\otimes|tensor product
Arithmetic|circled dot|⊙|\odot|circled dot
Arithmetic|square root|√|\sqrt{}|radical root
Arithmetic|cube root|∛|\sqrt[3]{}|nth root
Arithmetic|infinity|∞|\infty|infinite
Arithmetic|factorial|!|!|factorial
Arithmetic|percent|%|%|percent modulo
Relations|equals|=|=|equal
Relations|not equal|≠|\ne|\neq unequal
Relations|approximately equal|≈|\approx|approx
Relations|equivalent|≡|\equiv|identical congruent
Relations|less than|<|<|smaller than
Relations|greater than|>|>|larger than
Relations|less than or equal|≤|\leq|\le less than equal
Relations|greater than or equal|≥|\geq|\ge greater than equal
Relations|much less than|≪|\ll|far less than
Relations|much greater than|≫|\gg|far greater than
Relations|proportional to|∝|\propto|proportional
Relations|similar to|∼|\sim|similar tilde
Relations|congruent|≅|\cong|congruence
Relations|perpendicular|⊥|\perp|orthogonal
Relations|parallel|∥|\parallel|parallel to
Relations|divides|∣|\mid|such that divides
Relations|not divides|∤|\not\mid|does not divide
Relations|precedes|≺|\prec|preceded by
Relations|succeeds|≻|\succ|succeeded by
Relations|less or equivalent|≲|<\sim|less similar less tilde
Relations|greater or equivalent|≳|>\sim|greater similar greater tilde
Sets & Logic|element of|∈|\in|belongs to member of
Sets & Logic|not an element|∉|\notin|not in does not belong
Sets & Logic|contains|∋|\ni|contains as member
Sets & Logic|subset|⊂|\subset|proper subset
Sets & Logic|subset or equal|⊆|\subseteq|subset equal
Sets & Logic|not subset|⊄|\nsubset|not a subset
Sets & Logic|superset|⊃|\supset|proper superset
Sets & Logic|superset or equal|⊇|\supseteq|superset equal
Sets & Logic|union|∪|\cup|set union
Sets & Logic|intersection|∩|\cap|set intersection
Sets & Logic|empty set|∅|\emptyset|null set
Sets & Logic|logical and|∧|\land|wedge conjunction
Sets & Logic|logical or|∨|\lor|vee disjunction
Sets & Logic|logical not|¬|\neg|not negation
Sets & Logic|therefore|∴|\therefore|thus
Sets & Logic|because|∵|\because|since
Sets & Logic|exists|∃|\exists|there exists
Sets & Logic|not exists|∄|\neg\exists|nexists does not exist
Sets & Logic|for all|∀|\forall|universal quantifier
Sets & Logic|big union|⋃|\bigcup|union operator
Sets & Logic|big intersection|⋂|\bigcap|intersection operator
Arrows|left arrow|←|\leftarrow|leftwards arrow
Arrows|right arrow|→|\rightarrow|\to rightwards arrow maps to
Arrows|up arrow|↑|\uparrow|upwards arrow
Arrows|down arrow|↓|\downarrow|downwards arrow
Arrows|left right arrow|↔|\leftrightarrow|both directions
Arrows|up down arrow|↕|\updownarrow|vertical arrow
Arrows|double left arrow|⇐|\Leftarrow|left implies
Arrows|double right arrow|⇒|\Rightarrow|implies
Arrows|double left right arrow|⇔|\Leftrightarrow|if and only if iff
Arrows|maps to|↦|\mapsto|mapping
Arrows|long left arrow|⟵|\longleftarrow|long leftwards
Arrows|long right arrow|⟶|\longrightarrow|long rightwards
Arrows|long double right arrow|⟹|\Longrightarrow|long implies
Arrows|not double right arrow|⇏|\neg\Rightarrow|nRightarrow does not imply
Arrows|hook right arrow|↪|\hookrightarrow|injection hook
Arrows|two headed right arrow|↠|↠|surjection
Arrows|right harpoon|⇀|\rightharpoonup|harpoon arrow
Arrows|north east arrow|↗|\nearrow|diagonal up right
Arrows|south east arrow|↘|\searrow|diagonal down right
Calculus & Operators|sum|∑|\sum|summation sigma
Calculus & Operators|product|∏|\prod|product operator
Calculus & Operators|coproduct|∐|\coprod|co product
Calculus & Operators|integral|∫|\int|integrate
Calculus & Operators|double integral|∬|\int\int|area integral
Calculus & Operators|triple integral|∭|\int\int\int|volume integral
Calculus & Operators|contour integral|∮|\oint|line integral
Calculus & Operators|partial derivative|∂|\partial|partial differential
Calculus & Operators|nabla|∇|\nabla|del gradient divergence
Calculus & Operators|limit|lim|\lim|limit operator
Calculus & Operators|maximum|max|\max|maximum operator
Calculus & Operators|minimum|min|\min|minimum operator
Calculus & Operators|determinant|det|\det|determinant operator
Calculus & Operators|logarithm|log|\log|logarithm operator
Calculus & Operators|natural logarithm|ln|\ln|natural log
Calculus & Operators|real part|Re|\Re|real component
Calculus & Operators|imaginary part|Im|\Im|imaginary component
Delimiters|left floor|⌊|\lfloor|floor down
Delimiters|right floor|⌋|\rfloor|floor down
Delimiters|left ceiling|⌈|\lceil|ceiling up
Delimiters|right ceiling|⌉|\rceil|ceiling up
Delimiters|left angle bracket|⟨|⟨|inner product
Delimiters|right angle bracket|⟩|⟩|inner product
Delimiters|left brace|{|\lbrace|curly left bracket
Delimiters|right brace|}|\rbrace|curly right bracket
Delimiters|left bracket|[|[|square left bracket
Delimiters|right bracket|]|]|square right bracket
Delimiters|absolute value bars|∣∣|∣∣|modulus absolute value
Delimiters|norm bar|‖|‖|double bar norm magnitude
Accents|overline|x̄|\overline{}|bar average closure
Accents|underline|x̲|\underline{}|under bar
Accents|hat|x̂|x̂|circumflex estimate
Accents|wide hat|x̂|x̂|wide circumflex
Accents|tilde|x̃|x̃|accent wave
Accents|wide tilde|x̃|x̃|wide accent wave
Accents|vector|x⃗|\vec{}|vector arrow
Accents|dot|ẋ|ẋ|time derivative
Accents|double dot|ẍ|ẍ|second time derivative
Miscellaneous|degree|°|^\circ|degrees angle
Miscellaneous|prime|′|'|derivative minutes
Miscellaneous|aleph|ℵ|\aleph|transfinite cardinal
Miscellaneous|hbar|ℏ|\hbar|reduced Planck constant
Miscellaneous|ell|ℓ|\ell|script lowercase l
Miscellaneous|blackboard real numbers|ℝ|\R|real number set
Miscellaneous|blackboard integers|ℤ|\Z|integer set
Miscellaneous|blackboard natural numbers|ℕ|\N|natural number set
Miscellaneous|blackboard rational numbers|ℚ|\Q|rational number set
Miscellaneous|blackboard complex numbers|ℂ|\C|complex number set
Miscellaneous|bullet|∙|\bullet|bullet point
Miscellaneous|diamond|⋄|\diamond|diamond operator
Miscellaneous|dagger|†|\dagger|hermitian adjoint
Miscellaneous|double dagger|‡|\ddagger|double dagger
`;

export const MOBILE_KEYBOARD_SYMBOLS = Object.freeze(source.trim().split("\n").map((line, index) => {
  const [category, label, glyph, latex, aliases] = line.split("|");
  return Object.freeze({ id: index, category, label, glyph, latex, aliases });
}));

export function filterMobileSymbols(symbols, { category = "All", query = "" } = {}) {
  const normalizedQuery = String(query).trim().toLocaleLowerCase();
  return symbols.filter((symbol) => {
    if (category !== "All" && symbol.category !== category) return false;
    if (!normalizedQuery) return true;
    return [symbol.label, symbol.aliases, symbol.latex]
      .join(" ")
      .toLocaleLowerCase()
      .includes(normalizedQuery);
  });
}

export function mobileKeyboardLetter(value, { shifted = false, capsLock = false } = {}) {
  const letter = String(value);
  if (!/^[a-z]$/i.test(letter)) return letter;
  return shifted || capsLock ? letter.toLocaleUpperCase() : letter.toLocaleLowerCase();
}

export function mobileKeyboardPower(exponent = null) {
  if (exponent === null) return "^{}";
  if (!Number.isInteger(exponent) || exponent < 1 || exponent > 10) {
    throw new RangeError("Power shortcut exponent must be an integer from 1 through 10");
  }
  return `^{${exponent}}`;
}