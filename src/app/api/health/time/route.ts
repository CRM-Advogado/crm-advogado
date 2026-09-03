// ============================================================
// GET /api/health/time
//
// Public — no auth required. Diagnóstico do relógio do servidor.
//
// A condição `time_of_day` das automações compara com o relógio
// local do PROCESSO Node (lib/automations/engine.ts), não com o
// de Brasília — e o processo pode rodar num fuso diferente do
// painel da hospedagem (container Docker costuma vir em UTC).
// Esta rota devolve exatamente o que o motor enxerga, para que
// as faixas "HH:mm-HH:mm" sejam escritas no fuso certo.
//
// Não expõe nada além da hora e do fuso do processo — informação
// equivalente à do header `Date` que toda resposta HTTP já leva.
// ============================================================

import { NextResponse } from 'next/server';

export function GET() {
  const now = new Date();
  return NextResponse.json({
    iso_utc: now.toISOString(),
    local: now.toString(),
    time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    offset_minutes: -now.getTimezoneOffset(),
    hour_local: now.getHours(),
    minute_local: now.getMinutes(),
  });
}
