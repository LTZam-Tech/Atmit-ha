{{- define "atimtha.name" -}}{{ .Release.Name | trunc 40 | trimSuffix "-" }}{{- end -}}

{{- define "atimtha.labels" -}}
app.kubernetes.io/part-of: atimtha
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}

{{- define "atimtha.selector" -}}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{- define "atimtha.image" -}}{{ printf "%s/%s:%s" .root.Values.image.registry .name .root.Values.image.tag }}{{- end -}}

{{/* the database passwords as environment variables; connection strings refer to them with $(NAME) */}}
{{- define "atimtha.dbEnv" -}}
- name: ATIMTHA_DB_OWNER_PASSWORD
  valueFrom: { secretKeyRef: { name: {{ .Values.database.existingSecret }}, key: owner-password } }
- name: ATIMTHA_DB_APP_PASSWORD
  valueFrom: { secretKeyRef: { name: {{ .Values.database.existingSecret }}, key: app-password } }
{{- end -}}

{{- define "atimtha.db" -}}Host={{ .Values.database.host }};Port={{ .Values.database.port }};Database={{ .Values.database.name }};SSL Mode={{ .Values.database.sslMode }}{{- end -}}

{{- define "atimtha.pod" -}}
{{- with .Values.imagePullSecrets }}
imagePullSecrets: {{ toYaml . | nindent 2 }}
{{- end }}
securityContext: {{ toYaml .Values.podSecurityContext | nindent 2 }}
{{- with .Values.nodeSelector }}
nodeSelector: {{ toYaml . | nindent 2 }}
{{- end }}
{{- with .Values.tolerations }}
tolerations: {{ toYaml . | nindent 2 }}
{{- end }}
{{- with .Values.affinity }}
affinity: {{ toYaml . | nindent 2 }}
{{- end }}
{{- end -}}
