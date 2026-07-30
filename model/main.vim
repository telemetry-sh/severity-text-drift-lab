set nomore

function! s:EnvInt(name, fallback) abort
  let l:value = getenv(a:name)
  if type(l:value) != v:t_string || l:value !~# '^-\=\d\+$'
    return a:fallback
  endif
  return str2nr(l:value)
endfunction

function! s:Clamp(value, minimum, maximum) abort
  return min([a:maximum, max([a:minimum, a:value])])
endfunction

let s:total_logs = s:Clamp(s:EnvInt('LAB_TOTAL_LOGS', 100000), 100, 10000000)
let s:error_rate_bps = s:Clamp(s:EnvInt('LAB_ERROR_RATE_BASIS_POINTS', 120), 0, 10000)
let s:canonical_text_bps = s:Clamp(s:EnvInt('LAB_CANONICAL_TEXT_BASIS_POINTS', 3500), 0, 10000)

let s:error_logs = (s:total_logs * s:error_rate_bps + 5000) / 10000
let s:canonical_logs = (s:error_logs * s:canonical_text_bps + 5000) / 10000
let s:hidden_logs = s:error_logs - s:canonical_logs

" Allocate the non-canonical population deterministically while preserving totals.
let s:err_logs = (s:hidden_logs * 5) / 13
let s:severe_logs = (s:hidden_logs * 4) / 13
let s:fatal_logs = (s:hidden_logs * 2) / 13
let s:missing_logs = s:hidden_logs - s:err_logs - s:severe_logs - s:fatal_logs

let s:text_coverage_bps = s:error_logs == 0 ? 10000 : (s:canonical_logs * 10000) / s:error_logs
let s:hidden_share_bps = s:error_logs == 0 ? 0 : (s:hidden_logs * 10000) / s:error_logs

let s:result = {
      \ 'meta': {
      \   'lab': 'severity-text-drift',
      \   'engine': 'vimscript',
      \   'model_version': 1
      \ },
      \ 'inputs': {
      \   'total_logs': s:total_logs,
      \   'error_rate_basis_points': s:error_rate_bps,
      \   'canonical_text_basis_points': s:canonical_text_bps
      \ },
      \ 'population': {
      \   'total_logs': s:total_logs,
      \   'error_logs': s:error_logs,
      \   'non_error_logs': s:total_logs - s:error_logs
      \ },
      \ 'variants': [
      \   {'severity_text': 'ERROR', 'severity_number': 17, 'count': s:canonical_logs, 'canonical': v:true},
      \   {'severity_text': 'ERR', 'severity_number': 17, 'count': s:err_logs, 'canonical': v:false},
      \   {'severity_text': 'SEVERE', 'severity_number': 17, 'count': s:severe_logs, 'canonical': v:false},
      \   {'severity_text': 'FATAL', 'severity_number': 21, 'count': s:fatal_logs, 'canonical': v:false},
      \   {'severity_text': v:null, 'severity_number': 17, 'count': s:missing_logs, 'canonical': v:false}
      \ ],
      \ 'strategies': [
      \   {
      \     'id': 'text-only',
      \     'label': 'Exact text filter',
      \     'predicate': 'severity_text == "ERROR"',
      \     'visible_errors': s:canonical_logs,
      \     'hidden_errors': s:hidden_logs,
      \     'coverage_basis_points': s:text_coverage_bps
      \   },
      \   {
      \     'id': 'number-aware',
      \     'label': 'Normalized severity filter',
      \     'predicate': 'severity_number >= 17',
      \     'visible_errors': s:error_logs,
      \     'hidden_errors': 0,
      \     'coverage_basis_points': 10000
      \   }
      \ ],
      \ 'summary': {
      \   'text_filter_visible': s:canonical_logs,
      \   'text_filter_hidden': s:hidden_logs,
      \   'text_filter_coverage_basis_points': s:text_coverage_bps,
      \   'hidden_share_basis_points': s:hidden_share_bps,
      \   'numeric_filter_visible': s:error_logs,
      \   'numeric_filter_coverage_basis_points': 10000
      \ },
      \ 'finding': printf(
      \   'The exact text filter finds %d of %d erroneous logs; normalized severity finds all %d.',
      \   s:canonical_logs,
      \   s:error_logs,
      \   s:error_logs
      \ )
      \ }

call writefile([json_encode(s:result)], '/dev/stdout')
qa!
