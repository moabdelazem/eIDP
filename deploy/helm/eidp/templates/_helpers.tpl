{{/* Names */}}
{{- define "eidp.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "eidp.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{- define "eidp.api.fullname" -}}{{ include "eidp.fullname" . | trunc 59 | trimSuffix "-" }}-api{{- end }}
{{- define "eidp.web.fullname" -}}{{ include "eidp.fullname" . | trunc 59 | trimSuffix "-" }}-web{{- end }}
{{- define "eidp.postgres.fullname" -}}{{ include "eidp.fullname" . | trunc 54 | trimSuffix "-" }}-postgres{{- end }}

{{- define "eidp.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/* Labels. `component` is api, web or postgres. */}}
{{- define "eidp.labels" -}}
helm.sh/chart: {{ include "eidp.chart" .root }}
app.kubernetes.io/name: {{ include "eidp.name" .root }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .component }}
app.kubernetes.io/part-of: eidp
app.kubernetes.io/version: {{ .root.Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .root.Release.Service }}
{{- end }}

{{- define "eidp.selectorLabels" -}}
app.kubernetes.io/name: {{ include "eidp.name" .root }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end }}

{{- define "eidp.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "eidp.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{- define "eidp.image" -}}
{{- printf "%s:%s" .image.repository (default .root.Chart.AppVersion .image.tag) }}
{{- end }}

{{/*
A random value kept across upgrades: read back from the live Secret when it
exists, generated otherwise. `helm template` (no cluster) always generates.
*/}}
{{- define "eidp.keptRandom" -}}
{{- $existing := lookup "v1" "Secret" .root.Release.Namespace .secret }}
{{- if and $existing (hasKey $existing.data .key) }}
{{- index $existing.data .key }}
{{- else }}
{{- randAlphaNum .length | b64enc }}
{{- end }}
{{- end }}

{{/* Pod security that passes the "restricted" Pod Security Standard. */}}
{{- define "eidp.containerSecurityContext" -}}
allowPrivilegeEscalation: false
readOnlyRootFilesystem: true
runAsNonRoot: true
capabilities:
  drop: ["ALL"]
seccompProfile:
  type: RuntimeDefault
{{- end }}

{{/*
Soft spread across nodes and zones, unless the component names its own.
Usage: include "eidp.spread" (dict "root" . "component" "api" "own" $api.topologySpreadConstraints)
*/}}
{{- define "eidp.spread" -}}
{{- if .own }}
topologySpreadConstraints:
  {{- toYaml .own | nindent 2 }}
{{- else if .root.Values.spreadPods }}
topologySpreadConstraints:
  {{- range $key := list "kubernetes.io/hostname" "topology.kubernetes.io/zone" }}
  - maxSkew: 1
    topologyKey: {{ $key }}
    whenUnsatisfiable: ScheduleAnyway
    labelSelector:
      matchLabels:
        {{- include "eidp.selectorLabels" (dict "root" $.root "component" $.component) | nindent 8 }}
  {{- end }}
{{- end }}
{{- end }}
