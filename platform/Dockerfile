# Atimtha platform API. Build from the repository root:
#   docker build -f platform/Dockerfile -t atimtha/platform:dev .
FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src
COPY platform/Directory.Build.props platform/Directory.Packages.props ./
COPY platform/src/Atimtha.Api/Atimtha.Api.csproj src/Atimtha.Api/
RUN dotnet restore src/Atimtha.Api/Atimtha.Api.csproj
COPY platform/src/ src/
RUN dotnet publish src/Atimtha.Api/Atimtha.Api.csproj -c Release -o /app --no-restore

FROM mcr.microsoft.com/dotnet/aspnet:10.0 AS runtime
WORKDIR /app
COPY --from=build /app ./
COPY db/migrations ./migrations
# evidence files and branding logos: mount a volume here; the app user owns it
RUN mkdir -p /var/lib/atimtha/evidence && chown -R $APP_UID /var/lib/atimtha
ENV ASPNETCORE_URLS=http://+:8080 \
    Migrations__Path=/app/migrations \
    Evidence__Directory=/var/lib/atimtha/evidence
EXPOSE 8080
# the aspnet image's non-root user; health is probed from outside at /health/live and /health/ready
USER $APP_UID
ENTRYPOINT ["dotnet", "Atimtha.Api.dll"]
